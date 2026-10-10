# Codex and CLv2 Operations

This is the canonical current operator runbook for ECC's native Codex plugin
and Continuous Learning v2 (CLv2) runtime.

## Validated baseline

- ECC version: `2.2.3`
- Branch: `codex/clv2-native-observer`
- Validated commit: `8653307ff5b8c4f05944b0b5a4dda6c62e1e750a`

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

For validated commit `8653307ff5b8c4f05944b0b5a4dda6c62e1e750a`, the hashes were:

```text
observer-loop.sh  e06204e0635cda8afa5733ad2a6f72a7ccc9a8d87bb0410c5ab6d7e6f023fc93
start-observer.sh b709797024ecdeaa43852c938b233030dc34e4d46a54a22da99955e413051d76
```

These are baseline evidence, not permanent values after upgrades. `ecc-update`
compares the installed files to the current marketplace snapshot.

## Runtime configuration

The current validated environment uses `~/.codex/.env`:

```text
ECC_OBSERVER_PROVIDER=codex
ECC_OBSERVER_CODEX_HOME=/Users/daverpa/.codex-ecc-dev
ECC_OBSERVER_CODEX_MODEL=gpt-5.5
CLV2_PYTHON_CMD=/Users/daverpa/.pyenv/versions/ecc-clv2/bin/python3
```

These absolute paths describe one validated machine, not portable defaults.

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

- `observer-memory.test.js`: 27 passing and 5 failing legacy static Claude
  invocation expectations.
- `provider-leaky` naming remains.
- Residual pathname/TOCTOU hardening opportunities remain.
- Full filesystem-transactional ingest is not implemented.

## Pending operational validation

With the Mac awake and no active Codex session lease, leave the project inactive
for more than 30 minutes (approximately 35 minutes), then verify with
`clv2-health` that the observer stopped. If an active session lease remains,
the observer staying alive may be expected.
