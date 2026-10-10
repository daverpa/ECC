import importlib.util
import json
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "codex_observer_telemetry",
    __file__.replace("test_codex_observer_telemetry.py", "codex-observer-telemetry.py"),
)
telemetry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(telemetry)


def run_telemetry(tmp_path, lines, capsys):
    event_file = tmp_path / "events.jsonl"
    event_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    import sys
    old = sys.argv
    sys.argv = ["telemetry", str(event_file), "4", "3", "100", "80"]
    try:
        assert telemetry.main() == 0
    finally:
        sys.argv = old
    return dict(part.split("=", 1) for part in capsys.readouterr().out.strip().split())


def test_all_usage_fields_and_event_counts(tmp_path, capsys):
    lines = [
        json.dumps({"type": "item.started", "item": {"type": "reasoning"}}),
        json.dumps({"type": "item.completed", "item": {"type": "command_execution"}}),
        json.dumps({"type": "turn.completed", "usage": {
            "input_tokens": 1000, "cached_input_tokens": 200,
            "cache_write_input_tokens": 50, "output_tokens": 300,
            "reasoning_output_tokens": 120}}),
    ]
    result = run_telemetry(tmp_path, lines, capsys)
    assert result["uncached_input_tokens"] == "800"
    assert result["effective_tokens"] == "1100"
    assert result["raw_total_tokens"] == "1300"
    assert result["reasoning_output_tokens"] == "120"
    assert result["item_started"] == "1" and result["item_completed"] == "1"


def test_missing_optional_usage_is_explicit(tmp_path, capsys):
    result = run_telemetry(tmp_path, [json.dumps({"type": "turn.completed", "usage": {"input_tokens": 9}})], capsys)
    assert result["input_tokens"] == "9"
    assert result["cached_input_tokens"] == "unavailable"
    assert result["effective_tokens"] == "unavailable"


def test_malformed_line_does_not_fail_telemetry(tmp_path, capsys):
    result = run_telemetry(tmp_path, ["not-json", json.dumps({"type": "turn.completed", "usage": {}})], capsys)
    assert result["malformed_lines"] == "1"
    assert result["total_events"] == "1"


def test_multiple_turn_completions_are_explicitly_ambiguous(tmp_path, capsys):
    result = run_telemetry(tmp_path, [
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}),
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 4}}),
    ], capsys)
    assert result["usage_status"] == "ambiguous_turn_completed"
    assert result["turn_completed_events"] == "2"
    assert result["input_tokens"] == "unavailable"
    assert result["effective_tokens"] == "unavailable"


def test_unknown_events_are_ignored_and_sensitive_content_is_not_logged(tmp_path, capsys):
    secret = "sensitive project output"
    result = run_telemetry(tmp_path, [
        json.dumps({"type": "future.event", "secret": secret}),
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}),
    ], capsys)
    output = capsys.readouterr().out
    assert result["total_events"] == "2"
    assert secret not in output


def test_reasoning_tokens_are_not_added_again(tmp_path, capsys):
    result = run_telemetry(tmp_path, [json.dumps({
        "type": "turn.completed", "usage": {
            "input_tokens": 10, "cached_input_tokens": 2,
            "output_tokens": 5, "reasoning_output_tokens": 3}})], capsys)
    assert result["effective_tokens"] == "13"
    assert result["raw_total_tokens"] == "15"


def test_loop_keeps_telemetry_failure_outside_ingest_semantics():
    loop = Path(__file__).parents[3] / "skills/continuous-learning-v2/agents/observer-loop.sh"
    source = loop.read_text(encoding="utf-8")
    telemetry = source.index("telemetry_line=")
    validation = source.index("result_parent=", telemetry)
    block = source[telemetry:validation]
    assert "telemetry_status" in block
    assert "telemetry_problem=" in block
    assert "return" not in block


def test_loop_cleans_event_file_on_success_and_failure():
    loop = Path(__file__).parents[3] / "skills/continuous-learning-v2/agents/observer-loop.sh"
    source = loop.read_text(encoding="utf-8")
    assert 'rm -f "$analysis_event_file"' in source
    assert '[ -n "$ACTIVE_EVENT_FILE" ] && rm -f "$ACTIVE_EVENT_FILE"' in source
