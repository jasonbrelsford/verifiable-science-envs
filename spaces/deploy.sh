#!/usr/bin/env bash
# Push the HLA-Verify app to a Hugging Face Space from your own machine.
# (The same deploy runs on GitHub Actions with the repo's HF_TOKEN secret: .github/workflows/hf-space.yml.)
#
# Usage (repo root, Git Bash):
#   HF_TOKEN=hf_xxx ./spaces/deploy.sh [owner/space-name]      (default jason-brelsford/hla-verify)
#
# HF_TOKEN needs WRITE access to the Space (https://huggingface.co/settings/tokens).
#
# SPACE_SDK=static (default) deploys spaces/hla-verify/: the interactive page that calls
#   api.hlaverify.com from the visitor's browser, plus offline.html (the Pyodide checker).
#   Static Spaces are free for every account.
# SPACE_SDK=gradio deploys spaces/hla-verify-gradio/ instead. Hugging Face only hosts Gradio and
#   Docker Spaces on free cpu-basic for PRO accounts, so this fails on a free account. Optional
#   HLAVERIFY_API_KEY=hlv_xxx stores that key as a Space secret (the Gradio app calls the API
#   server-side, so without one every visitor shares the Space's anonymous quota).
#
# Every file in the Space is replaced by the new build; anything else there is removed.
set -euo pipefail
SPACE="${1:-jason-brelsford/hla-verify}"
SDK="${SPACE_SDK:-static}"
PY="${PYTHON:-python}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${HF_TOKEN:?set HF_TOKEN to a write token from https://huggingface.co/settings/tokens}"
AUTH="Authorization: Bearer $HF_TOKEN"

case "$SDK" in
  static) "$PY" "$HERE/build_static.py" >/dev/null; SRC="$HERE/../build/space" ;;
  gradio) SRC="$HERE/hla-verify-gradio" ;;
  *) echo "SPACE_SDK must be static or gradio" >&2; exit 2 ;;
esac

# Create the Space if it does not exist yet (an error saying it exists is expected and ignored).
curl -s -o /dev/null -X POST https://huggingface.co/api/repos/create \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"${SPACE#*/}\",\"organization\":null,\"sdk\":\"$SDK\",\"private\":false}" || true

D=$(mktemp -d); trap 'cd /; rm -rf "$D"' EXIT   # the clone URL holds the token; never leave it on disk
git clone -q "https://user:$HF_TOKEN@huggingface.co/spaces/$SPACE" "$D"
( cd "$D" && git ls-files | grep -v '^\.gitattributes$' | while IFS= read -r f; do git rm -q -- "$f"; done )
for f in "$SRC"/*; do
  case "$(basename "$f")" in __pycache__) continue ;; esac
  cp "$f" "$D/"
  git -C "$D" add -- "$(basename "$f")"
done
cd "$D"
if git diff --cached --quiet; then
  echo "Space already up to date: https://huggingface.co/spaces/$SPACE"
else
  git -c user.name="Jason Brelsford" -c user.email="jason.brelsford@gmail.com" \
    commit -qm "Deploy HLA-Verify ($SDK) from verifiable-science-envs/spaces"
  git push -q
  echo "pushed -> https://huggingface.co/spaces/$SPACE"
fi

if [ "$SDK" = gradio ] && [ -n "${HLAVERIFY_API_KEY:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://huggingface.co/api/spaces/$SPACE/secrets" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"key\":\"HLAVERIFY_API_KEY\",\"value\":\"$HLAVERIFY_API_KEY\",\"description\":\"HLA-Verify API key for visitors without one\"}")
  echo "Space secret HLAVERIFY_API_KEY: HTTP $code (200 = set; the Space restarts to pick it up)"
fi
