# Codex and CLv2 Operations

This is the canonical current operator runbook for ECC's native Codex plugin
and Continuous Learning v2 (CLv2) runtime.

## Validated baseline

- ECC version: `2.2.3`
- Branch: `codex/clv2-native-observer`
- Validated commit: `ef8dc02ffbf456e59e92ccce32d4e7d971747e02`

This commit and the hashes below describe a validated baseline. They are not
permanent expected values after future upgrades.

## Distribution model

```text
GitHub fork: https://github.com/daverpa/ECC.git
        ↓ ref codex/clv2-native-observer
Git marketplace: ecc
        ↓
Marketplace snapshot: ~/.codex/.tmp/marketplaces/ecc
        ↓
Plugin cache: ~/.codex/plugins/cache/ecc/ecc/2.2.3
        ↓
Codex App
```

Codex App executes the materialized plugin cache, not the development checkout.
Keep these layers distinct: development checkout, marketplace snapshot,
installed plugin cache, and active Codex App runtime.

## Installation

```bash
codex plugin marketplace add daverpa/ECC --ref codex/clv2-native-observer
codex plugin add ecc@ecc
```

Local-path marketplace installation is for development/testing only.

## Daily update

Run:

```bash
ecc-update
```

The wrapper upgrades marketplace `ecc`, removes and reinstalls `ecc@ecc`,
locates the installed plugin root, compares critical CLv2 files against the
marketplace snapshot, and reports the remote, ref, commit, plugin root, version,
and CLv2 verification status. It exits non-zero on errors.

The marketplace snapshot defaults to
`$HOME/.codex/.tmp/marketplaces/ecc`. Set `ECC_MARKETPLACE_ROOT` only when
Codex stores that snapshot elsewhere or for diagnostics/testing; normal users
should not need to set it.

## Runtime verification

Prefer direct evidence: the active plugin path, plugin metadata, hook paths,
process command lines when available, and SHA-256 comparisons. The critical
files are:

```text
skills/continuous-learning-v2/agents/observer-loop.sh
skills/continuous-learning-v2/agents/start-observer.sh
```

For validated commit `ef8dc02ffbf456e59e92ccce32d4e7d971747e02`, the hashes are:

```text
observer-loop.sh  9a5a3b4ed4db1c062061d2e139fb220dbc11b94337972857b1a773dae64ba07b
start-observer.sh b709797024ecdeaa43852c938b233030dc34e4d46a54a22da99955e413051d76
```

These are validated evidence, not permanent values after upgrades. `ecc-update`
compares the installed files to the current marketplace snapshot.

## Codex observer optimization

The validated observer architecture keeps host-side snapshotting, compaction,
and structured ingest unchanged, but changes how Codex receives observations.
Previously, the host created and compacted a sampled observation file, Codex
was instructed to read that file, and Codex used tool/model rounds to inspect
the observations while accumulated context was repeatedly processed. Now the
host still snapshots and compacts observations, then embeds the compacted
observations directly in the Codex prompt as explicitly delimited untrusted
data. The complete prompt is passed through stdin with `codex exec ... -`.
Codex no longer needs tools to read observation data.

The validated end-to-end measurement for this dataset/configuration was:

```text
Dataset:
  raw_observations=40
  compacted_observations=40
  raw_bytes=91609
  compacted_bytes=90926

Before:
  input_tokens=217345
  raw_total_tokens=220098
  command_tool_items=10
  approximate duration=65s

After:
  input_tokens=42483
  raw_total_tokens=43389
  command_tool_items=0
  approximate duration=23s

Derived comparison:
  input_tokens reduction approximately 80.45%
  raw_total_tokens reduction approximately 80.29%
  command tool items reduced from 10 to 0
```

These are measured results for this validated dataset/configuration, not
universal guarantees or billing estimates. A controlled direct-payload
benchmark produced `input_tokens=42097` for the same full observation archive,
within about 0.92% of the optimized production E2E result of `42483`. This is
supporting validation, not a universal expected value.

A second natural observer-cycle validation was also completed on a different
repository (`all-agentic-architectures`) with a larger observation payload:

```text
raw_observations=40
compacted_observations=40
raw_bytes=126136
compacted_bytes=125245
input_tokens=53648
raw_total_tokens=54746
command_tool_items=0
turn_completed_events=1
usage_status=selected_terminal_turn
```

The cycle completed normal host-side ingest (`create=5`) and archived the
processed observations. This provides an independent runtime validation that
the optimized observer remains tool-free with a larger payload. It is not a
universal expected token count.

## Runtime configuration

The current validated environment uses `~/.codex/.env`:

```text
ECC_OBSERVER_PROVIDER=codex
ECC_OBSERVER_CODEX_HOME=/Users/daverpa/.codex-ecc-dev
ECC_OBSERVER_CODEX_MODEL=gpt-5.5
CLV2_PYTHON_CMD=/Users/daverpa/.pyenv/versions/ecc-clv2/bin/python3
```

These absolute paths describe one validated machine, not portable defaults.

Manual observer launches inherit their environment from the invoking shell.
`start-observer.sh` does not automatically source `~/.codex/.env`.

When launching a Codex-backed observer manually, provide the required variables
explicitly or export them beforehand, for example:

```bash
ECC_OBSERVER_PROVIDER=codex \
ECC_OBSERVER_CODEX_HOME="$HOME/.codex-ecc-dev" \
ECC_OBSERVER_CODEX_MODEL="gpt-5.5" \
CLV2_PYTHON_CMD="$HOME/.pyenv/versions/ecc-clv2/bin/python3" \
start-observer.sh --reset
```

Codex App/native hook launches may already inherit these variables from their
runtime environment; manual shell launches must not assume that they do.

Local CLv2 configuration is `~/.local/share/ecc-homunculus/config.json`:

```json
{"observer":{"enabled":true,"run_interval_minutes":5,"min_observations_to_analyze":40}}
```

Relevant defaults are `ECC_OBSERVER_MAX_ANALYSIS_LINES=500`,
`ECC_OBSERVER_ANALYSIS_COOLDOWN=60`, and
`ECC_OBSERVER_IDLE_TIMEOUT_SECONDS=1800`.

## Lifecycle and project state

Native hooks lazy-start the observer. There is no global daemon and no
LaunchAgent. Idle shutdown applies only when no active session lease exists; an
active lease may intentionally keep the observer alive. macOS sleep/suspend can
make process `ETIME` appear much larger than actual active execution.

Project state lives under:

```text
~/.local/share/ecc-homunculus/projects/<project-id>
```

Use `clv2-health` and `clv2-instincts` for inspection. `clv2-instinct show` is
available; `clv2-instinct remove` is not yet validated as safe with respect to
recursive instinct loading and should not be treated as a verified operation.

## Codex observer usage telemetry

Successful native Codex observer analyses may append one aggregate
`CLV2_CODEX_USAGE` record to `observer.log`. The record contains diagnostic
payload measurements (`raw_observations`, `compacted_observations`,
`raw_bytes`, and `compacted_bytes`) and event counts (`total_events`,
`item_started`, `item_completed`, `command_tool_items`, `reasoning_items`,
`message_items`, and `turn_completed_events`).

When exactly one `turn.completed` event exposes usage, the following fields are
reported when available: `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens`, and `reasoning_output_tokens`.
Derived values are:

```text
uncached_input_tokens = input_tokens - cached_input_tokens
effective_tokens = uncached_input_tokens + output_tokens
raw_total_tokens = input_tokens + output_tokens
```

`reasoning_output_tokens` is a breakdown/subset of output usage and must not be
added again to `output_tokens`. Missing fields are reported as unavailable.
If multiple `turn.completed` usage events appear, usage is marked
`ambiguous_turn_completed` and no single usage value is selected; the observer
analysis itself is unaffected. Total `input_tokens` is the primary metric used
to study structural model/tool-round overhead. `cached_input_tokens` can vary
substantially between otherwise comparable runs, and `effective_tokens` remains
diagnostic; it must not be treated as a direct monetary cost metric. All
telemetry values are diagnostic and must not automatically be interpreted as
subscription, quota, or billing units unless OpenAI explicitly documents that
equivalence.

## Troubleshooting decision tree

1. Check the development checkout if the source itself is wrong.
2. Check the marketplace snapshot if the Git ref or fetched content is wrong.
3. Check the plugin cache with `ecc-update` if installation differs from the
   marketplace snapshot.
4. Restart or reopen Codex App when the active runtime needs refreshing.
5. Re-run cache and hash verification.

Do not manually delete the plugin cache as the normal update or recovery path.

## Maintenance workflow

```text
checkout changes → tests/review → commit → push → ecc-update
→ restart/reopen Codex App if needed → runtime verification
```

Development work and the daily installed runtime are separate workflows.

## Known limitations

- Current validation: `node tests/hooks/observer-memory.test.js` — 34 passed;
  `node tests/hooks/observer-loop-archive.test.js` — 29 passed; bash syntax
  checks passed; and `git diff --check` passed. This does not claim that the
  entire repository test suite was executed.
- `provider-leaky` naming remains.
- Residual pathname/TOCTOU hardening opportunities remain.
- Full filesystem-transactional ingest is not implemented.

## Pending operational validation

With the Mac awake and no active Codex session lease, leave the project inactive
for more than 30 minutes (approximately 35 minutes), then verify with
`clv2-health` that the observer stopped. If an active session lease remains,
the observer staying alive may be expected.

The current distributed version has been validated through `ecc-update` at
commit `ef8dc02ffbf456e59e92ccce32d4e7d971747e02`. The development checkout,
marketplace snapshot, installed plugin cache, and Codex App runtime remain
distinct distribution/runtime layers.
