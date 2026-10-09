#!/usr/bin/env bash
# Provider execution boundary for the Continuous Learning v2 observer.

set +e

provider="${1:-}"
model="${2:-}"
max_turns="${3:-}"
prompt="${4:-}"
result_path="${5:-}"
schema_path="${6:-}"
working_dir="${7:-}"

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
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      echo "codex CLI not found, skipping analysis" >&2
      exit 127
    fi
    if [ -z "$result_path" ]; then
      echo "codex observer result path is required" >&2
      exit 2
    fi
    if [ -z "$schema_path" ]; then
      echo "codex observer schema path is required" >&2
      exit 2
    fi
    if [ -z "$working_dir" ]; then
      echo "codex observer working directory is required" >&2
      exit 2
    fi

    codex_model_args=()
    if [ -n "$model" ]; then
      codex_model_args=(-m "$model")
    fi

    if [ -n "${ECC_OBSERVER_CODEX_HOME:-}" ]; then
      exec env CODEX_HOME="$ECC_OBSERVER_CODEX_HOME" codex --ask-for-approval never exec \
        --ephemeral \
        --ignore-user-config \
        --skip-git-repo-check \
        "${codex_model_args[@]}" \
        -c model_reasoning_effort="low" \
        -s read-only \
        -C "$working_dir" \
        --output-schema "$schema_path" \
        -o "$result_path" \
        "$prompt"
    fi

    exec codex --ask-for-approval never exec \
      --ephemeral \
      --ignore-user-config \
      --skip-git-repo-check \
      "${codex_model_args[@]}" \
      -c model_reasoning_effort="low" \
      -s read-only \
      -C "$working_dir" \
      --output-schema "$schema_path" \
      -o "$result_path" \
      "$prompt"
    ;;
  *)
    echo "unsupported observer provider: ${provider:-<empty>}" >&2
    exit 2
    ;;
esac
