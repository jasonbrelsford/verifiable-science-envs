"""GRPO fine-tune demo on Modal — the "our environment improved model X" artifact.

Trains Qwen2.5-3B-Instruct with LoRA + GRPO against the HLA-Bench-A reward
(deterministic grader; no reward model), on a TRAIN split generated from a
DIFFERENT seed than the sealed eval split (0 task-id overlap). The published
deliverable is the before/after table on the sealed split plus the tuned
adapter on Hugging Face with an honest model card.

Setup (one-time, ~5 min, Jason):
  pip install modal && modal setup            # creates account, browser auth
  modal secret create huggingface HF_TOKEN=<write token>   # for the upload step
Run:
  modal run scripts/train_grpo_modal.py       # ~3-5 h on one A100-40GB
Cost: ~$6-13 at $2.10/h; Modal Starter includes $30/mo free credits.

Status: ready for a first smoke run (--smoke trains 20 steps on 64 tasks).
"""
import modal

app = modal.App("hla-bench-grpo")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", "transformers>=4.44", "trl>=0.12", "peft", "datasets",
                 "accelerate", "bitsandbytes", "huggingface_hub")
    .run_commands("git clone https://github.com/jasonbrelsford/verifiable-science-envs /repo",
                  "pip install -e /repo")
)

MODEL = "Qwen/Qwen2.5-3B-Instruct"
TRAIN_SEED = 20260901          # disjoint from the sealed split's base seed
HF_REPO = "jason-brelsford/qwen2.5-3b-hla-bench-grpo"


@app.function(image=image, gpu="A100", timeout=6 * 3600,
              secrets=[modal.Secret.from_name("huggingface")])
def train(smoke: bool = False):
    import json, os, subprocess
    from pathlib import Path

    # 1. Generate the disjoint train suite inside the container.
    os.chdir("/repo")
    subprocess.run(["hla-bench", "generate", "--seed", str(TRAIN_SEED)], check=True)
    tasks = []
    for f in sorted(Path("runs/hla-bench-a/full").glob("*.full.json")):
        tasks.append(json.loads(f.read_text()))
    if smoke:
        tasks = tasks[:64]
    print(f"train tasks: {len(tasks)}")

    from sci_envs.reference.imgt import ImgtReference
    from sci_envs.families.nomenclature.grade import grade
    ref = ImgtReference.load("v3.65.0-alpha")
    by_prompt = {}

    def to_prompt(t):
        p = f"{t['instructions']}\n\nINPUT:\n{json.dumps(t['input'], indent=2)}"
        by_prompt[p] = t
        return p

    prompts = [{"prompt": to_prompt(t)} for t in tasks]

    def reward_fn(prompts, completions, **kw):
        out = []
        for p, c in zip(prompts, completions):
            t = by_prompt[p]
            s = grade(t, c, ref)
            r = (1.0 * s.correct
                 + 0.25 * (0 if s.hallucinated_names else 1)
                 + 0.10 * (1 if getattr(s, "calibrated", False) else 0)
                 + 0.10 * (1 if getattr(s, "flags_correct", False) else 0))
            out.append(r)
        return out

    # 2. GRPO with LoRA.
    from datasets import Dataset
    from peft import LoraConfig
    from trl import GRPOConfig, GRPOTrainer
    cfg = GRPOConfig(
        output_dir="/tmp/grpo", per_device_train_batch_size=4,
        num_generations=8, max_prompt_length=768, max_completion_length=256,
        learning_rate=1e-5, max_steps=20 if smoke else 400,
        logging_steps=5, save_steps=100, bf16=True,
    )
    trainer = GRPOTrainer(
        model=MODEL, args=cfg, train_dataset=Dataset.from_list(prompts),
        reward_funcs=reward_fn,
        peft_config=LoraConfig(r=16, lora_alpha=32, target_modules="all-linear"),
    )
    trainer.train()
    trainer.save_model("/tmp/grpo/final")

    # 3. Push adapter to HF (card added separately; honest before/after only
    #    after the sealed-split eval runs on TOWER).
    from huggingface_hub import HfApi
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(HF_REPO, exist_ok=True, private=True)  # public after eval
    api.upload_folder(folder_path="/tmp/grpo/final", repo_id=HF_REPO)
    print("adapter pushed (private):", HF_REPO)


@app.local_entrypoint()
def main(smoke: bool = False):
    train.remote(smoke=smoke)
