#!/usr/bin/env bash
# Push the HLA-Verify demo to a Hugging Face Space.
# Usage: HF_TOKEN=hf_xxx ./spaces/deploy.sh [owner/space-name]   (default jebidiag/hla-verify)
set -euo pipefail
SPACE="${1:-jebidiag/hla-verify}"
: "${HF_TOKEN:?set HF_TOKEN to a write token from https://huggingface.co/settings/tokens}"
curl -sf -X POST https://huggingface.co/api/repos/create \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"${SPACE#*/}\",\"organization\":null,\"sdk\":\"docker\",\"private\":false}" >/dev/null || true
D=$(mktemp -d); git clone -q "https://user:$HF_TOKEN@huggingface.co/spaces/$SPACE" "$D"
cp "$(dirname "$0")/hla-verify/README.md" "$(dirname "$0")/hla-verify/Dockerfile" "$D/"
cd "$D" && git add -A && git -c user.name=deploy -c user.email=deploy@local commit -qm "deploy HLA-Verify" && git push -q
echo "pushed → https://huggingface.co/spaces/$SPACE (build takes a few minutes)"
