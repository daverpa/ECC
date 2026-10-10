# Continuous Learning v2 Spec

This document captures the v2 continuous-learning architecture:

1. Hook-based observation capture
2. Background observer analysis loop
3. Instinct scoring and persistence
4. Evolution of instincts into reusable skills/commands

Primary implementation lives in:
- `skills/continuous-learning-v2/`
- `scripts/hooks/`

Use this file as the stable reference path for docs and translations.

## Validated Codex runtime model

The validated native Codex provider is used through the ECC plugin snapshot.
Native hooks lazy-start the observer and the observer shuts down after its
idle timeout when no active session lease remains. There is no global daemon
and no LaunchAgent. An active Codex session lease may intentionally keep the
observer alive.

The plugin/runtime code is distributed through the Codex marketplace and
installed plugin cache. Persistent CLv2 state is user-owned and remains under
`${XDG_DATA_HOME:-~/.local/share}/ecc-homunculus`, including project state under
`projects/<project-id>`. The runtime package and persistent learning data are
separate concerns.

## Known non-blocking technical debt

- `observer-memory.test.js` has 27 passing and 5 failing legacy static
  expectations tied to Claude invocation shape.
- `provider-leaky` naming remains in the implementation.
- Residual pathname/TOCTOU hardening opportunities remain.
- Full filesystem-transactional ingest is not implemented.

These items do not reopen the validated CLv2 architecture. Current operational
procedures belong in [`docs/codex-clv2-operations.md`](codex-clv2-operations.md).
