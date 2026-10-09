#!/usr/bin/env bash
# Provider execution boundary for the Continuous Learning v2 observer.

set +e

provider="${1:-}"
model="${2:-}"
max_turns="${3:-}"
prompt="${4:-}"

case "$provider" in
  claude)
    if ! command -v claude >/dev/null 2>&1; then
      echo "claude CLI not found, skipping analysis" >&2
      exit 127
    fi

    exec claude --model "$model" --max-turns "$max_turns" --print \
      --allowedTools "Read,Write" \
      -p "$prompt"
    ;;
  *)
    echo "unsupported observer provider: ${provider:-<empty>}" >&2
    exit 2
    ;;
esac
