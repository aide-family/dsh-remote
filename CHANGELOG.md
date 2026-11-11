# Changelog

## 0.10.1 — 2026-11-11

- Releases the operations-workspace, connection-progress, SSH-tab naming and shared-PTY improvements listed below.
- Fixes a CI fault-injection race: a late timed-out SSH request can no longer consume the rejection intended for a different command.
- Adds deterministic targeted-rejection coverage while preserving cancellation, unknown-outcome and no-automatic-replay assertions.
- The v0.10.0 publishing attempt was stopped by this CI failure before npm publication; its existing Git tag is unchanged.

## 0.10.0 (release candidate; not published to npm) — 2026-11-11

### Added
- Dedicated remote-operations workspace at `$DSH_HOME/workspaces/remote-ops`; each quick connection creates a fresh session in that fixed workspace.
- Global connection progress dialog with real stages, elapsed time, safe initialization progress, and distinct completed/running/failed/pending colors.
- Password dialogs stack above visible progress without competing for focus; successful connection automatically dismisses progress.
- Native terminal tabs use the logical SSH name, independently of the conversation's `SSH name · action` title.
- Target verification, safety profiles, durable safe-file-change backups, and truthful audit features from the preceding repository development version.

### Fixed
- Quick connect no longer submits an unsolicited Agent health-check task.
- Agent handle cleanup and disposal no longer terminate the user's shared native SSH PTY. Standalone Agent PTYs still close normally; explicit management close still terminates shared connections.
- Released handles cannot send input/signals or retain stale verification permissions. Unfinished operations report handle release, not a fabricated remote process exit.
- Negotiated bridge handshakes distinguish a definitively closed session from temporary transport/lookup failures, stopping reconnect storms without replaying old input.
- Coalesced handshake/input frames are preserved, background-window paint waits are bounded, and live-command records no longer steal selection from interactive terminal tabs.

### Compatibility and upgrade
- Requires DSH **0.2.2-rc.1 or newer**, matching the verified workspace/session/native terminal APIs.
- Restart DSH after upgrading to load backend lifecycle changes. Previously closed SSH PTYs cannot be resurrected; reconnect explicitly.
- `remote_shell_close` releases a borrowed shared handle rather than closing the user's SSH terminal. Use the management page's explicit SSH close when teardown is intended.
- Production incident transcripts, credentials, local debug logs, and local GUI-preview artifacts are excluded from the npm package.
