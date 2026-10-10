#!/usr/bin/env python3
"""Extract aggregate, non-sensitive telemetry from Codex JSONL events."""
import json
import sys


def main() -> int:
    path, raw_obs, compacted_obs, raw_bytes, compacted_bytes = sys.argv[1:]
    counts = {"total_events": 0, "item_started": 0, "item_completed": 0,
              "command_tool_items": 0, "reasoning_items": 0, "message_items": 0}
    usages = []
    malformed = 0
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if not isinstance(event, dict):
                continue
            counts["total_events"] += 1
            event_type = str(event.get("type", "")).lower()
            if event_type in ("item.started", "item_started"):
                counts["item_started"] += 1
            if event_type in ("item.completed", "item_completed"):
                counts["item_completed"] += 1
            item = event.get("item") if isinstance(event.get("item"), dict) else event
            item_type = str(item.get("type", "")).lower()
            if any(value in item_type for value in ("command", "tool", "function")):
                counts["command_tool_items"] += 1
            if "reason" in item_type:
                counts["reasoning_items"] += 1
            if "message" in item_type or "agent_message" in item_type:
                counts["message_items"] += 1
            if event_type in ("turn.completed", "turn_completed"):
                candidate = event.get("usage")
                if isinstance(candidate, dict):
                    usages.append(candidate)

    usage = usages[0] if len(usages) == 1 else {}

    fields = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
              "output_tokens", "reasoning_output_tokens")
    values = {field: usage.get(field) if isinstance(usage.get(field), int) else "unavailable"
              for field in fields}
    uncached = (values["input_tokens"] - values["cached_input_tokens"]
                if isinstance(values["input_tokens"], int) and isinstance(values["cached_input_tokens"], int)
                else "unavailable")
    effective = (uncached + values["output_tokens"]
                 if isinstance(uncached, int) and isinstance(values["output_tokens"], int)
                 else "unavailable")
    raw_total = (values["input_tokens"] + values["output_tokens"]
                 if isinstance(values["input_tokens"], int) and isinstance(values["output_tokens"], int)
                 else "unavailable")
    result = {"raw_observations": raw_obs, "compacted_observations": compacted_obs,
              "raw_bytes": raw_bytes, "compacted_bytes": compacted_bytes, **values,
              "uncached_input_tokens": uncached, "effective_tokens": effective,
              "raw_total_tokens": raw_total, "turn_completed_events": len(usages),
              "usage_status": ("selected_terminal_turn" if len(usages) == 1
                                else "ambiguous_turn_completed" if len(usages) > 1
                                else "unavailable"), **counts}
    if malformed:
        result["malformed_lines"] = malformed
    print(" ".join(f"{key}={value}" for key, value in result.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
