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
event_path="${8:-}"
prompt_path="${9:-}"

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
    # Keep direct callers compatible; the CLv2 loop supplies a private file.
    # A discarded stream is safer than mixing JSONL into the structured result.
    if [ -z "$event_path" ]; then
      event_path="/dev/null"
    fi
    if [ -n "$prompt_path" ] && [ ! -r "$prompt_path" ]; then
      echo "codex observer prompt path is not readable" >&2
      exit 2
    fi

    codex_model_args=()
    if [ -n "$model" ]; then
      codex_model_args=(-m "$model")
    fi

    codex_prompt_args=("$prompt")
    if [ -n "$prompt_path" ]; then
      codex_prompt_args=(-)
    fi

    if [ -n "${ECC_OBSERVER_CODEX_HOME:-}" ]; then
      if [ -n "$prompt_path" ]; then
        exec env CODEX_HOME="$ECC_OBSERVER_CODEX_HOME" codex --ask-for-approval never exec \
          --ephemeral --ignore-user-config --skip-git-repo-check --json \
          "${codex_model_args[@]}" -c model_reasoning_effort="low" -s read-only \
          -C "$working_dir" --output-schema "$schema_path" -o "$result_path" \
          "${codex_prompt_args[@]}" < "$prompt_path" > "$event_path"
      fi
      exec env CODEX_HOME="$ECC_OBSERVER_CODEX_HOME" codex --ask-for-approval never exec \
        --ephemeral \
        --ignore-user-config \
        --skip-git-repo-check \
        --json \
        "${codex_model_args[@]}" \
        -c model_reasoning_effort="low" \
        -s read-only \
        -C "$working_dir" \
        --output-schema "$schema_path" \
        -o "$result_path" \
        "$prompt" > "$event_path"
    fi

    if [ -n "$prompt_path" ]; then
      exec codex --ask-for-approval never exec \
        --ephemeral --ignore-user-config --skip-git-repo-check --json \
        "${codex_model_args[@]}" -c model_reasoning_effort="low" -s read-only \
        -C "$working_dir" --output-schema "$schema_path" -o "$result_path" \
        "${codex_prompt_args[@]}" < "$prompt_path" > "$event_path"
    fi
    exec codex --ask-for-approval never exec \
      --ephemeral \
      --ignore-user-config \
      --skip-git-repo-check \
      --json \
      "${codex_model_args[@]}" \
      -c model_reasoning_effort="low" \
      -s read-only \
      -C "$working_dir" \
      --output-schema "$schema_path" \
      -o "$result_path" \
      "$prompt" > "$event_path"
    ;;
  *)
    echo "unsupported observer provider: ${provider:-<empty>}" >&2
    exit 2
    ;;
esac
