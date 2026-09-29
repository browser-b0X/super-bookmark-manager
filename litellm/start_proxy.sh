#!/usr/bin/env bash
# Start the LiteLLM categorizer proxy on port 4000.
# Usage: ./start_proxy.sh            (foreground)
#        ./start_proxy.sh --daemon   (background, logs to litellm/proxy.log)
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a; source .env; set +a
else
  echo "[litellm] No .env found — copy .env.example to .env and add your keys."
  echo "[litellm] Continuing anyway: the local llama-server tier still works."
fi

# Defaults for the local tier
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8080/v1}"
export LLM_API_KEY="${LLM_API_KEY:-not-needed}"

if ! python3.12 -c "import litellm" 2>/dev/null; then
  echo "[litellm] Installing litellm[proxy]…"
  python3.12 -m pip install --user --quiet "litellm[proxy]"
fi

LITELLM_BIN="$(command -v litellm || echo "$HOME/.local/bin/litellm")"

if [[ "${1:-}" == "--daemon" ]]; then
  nohup "$LITELLM_BIN" --config config.yaml --port 4000 > proxy.log 2>&1 &
  echo "[litellm] Proxy started in background (pid $!), logs: litellm/proxy.log"
else
  exec "$LITELLM_BIN" --config config.yaml --port 4000
fi
