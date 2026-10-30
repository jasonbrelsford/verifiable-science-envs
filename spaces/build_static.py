"""Assemble the static Hugging Face Space for HLA-Verify into build/space/.

  index.html    the interactive app (spaces/hla-verify/index.html): calls api.hlaverify.com
                from the visitor's browser, so each visitor uses their own quota
  offline.html  the in-browser Pyodide checker (same template + engine source as
                hlaverify.com/demo); nothing leaves the tab
  README.md     Space card and metadata (sdk: static)
  favicon.png

Used by .github/workflows/hf-space.yml and spaces/deploy.sh. Run from the repo root:
    python spaces/build_static.py
"""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "space"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    src = ROOT / "spaces" / "hla-verify"
    shutil.copyfile(src / "index.html", OUT / "index.html")
    shutil.copyfile(src / "README.md", OUT / "README.md")
    fav = ROOT / "assets" / "favicon-64.png"
    if fav.exists():
        shutil.copyfile(fav, OUT / "favicon.png")

    demo = (ROOT / "assets" / "demo.template.html").read_text(encoding="utf-8")
    demo = demo.replace("__IMGT_PY__", json.dumps((ROOT / "sci_envs/reference/imgt.py").read_text(encoding="utf-8")))
    demo = demo.replace("__NORMALIZE_PY__", json.dumps(
        (ROOT / "sci_envs/families/nomenclature/normalize.py").read_text(encoding="utf-8")))
    # On the Space, "/" is the app, not hlaverify.com.
    demo = demo.replace('<a href="/">← hlaverify.com</a>', '<a href="index.html">← HLA-Verify app</a>')
    (OUT / "offline.html").write_text(demo, encoding="utf-8")
    for f in sorted(OUT.iterdir()):
        print(f"{f.name}: {f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
