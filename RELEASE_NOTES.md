# Kubebs v0.2.2

Shell reliability and desktop scrolling candidate. Publication is separate from local packaging.

## Changes

- One terminal per resource tab, retaining background output and 3,000 lines of scrollback across view switches. Closing a tab, disconnecting, or changing kubeconfig/context cancels its sessions. Namespace filtering preserves explicitly bound targets.
- Explicit connection states, cancellation during setup, a shared 30-second setup deadline, guarded callbacks, ordered input, coalesced resize requests, and idempotent cleanup. Reconnect starts a fresh attempt; commands are never replayed.
- Shell IPC carries bytes and structured failure/exit information. xterm handles split UTF-8 sequences. The default command remains `/bin/sh -i`.
- Terminal selections can be copied with Ctrl+Shift+C, the Copy selection button, or right-click. Ctrl+C remains the interrupt shortcut; Ctrl+V/Ctrl+Shift+V paste.
- Refresh, log errors, and rollout completions reject stale results. Rollout confirmation captures its resource/context, and native rollout commands verify the expected context.
- Logs distinguish connecting, live, ended, error, and paused states. Reading history preserves scroll position; Follow latest resumes following.
- Main panes, menus, logs and terminal viewports suppress edge bounce and chaining. Horizontal table/YAML/tab wrappers suppress horizontal overscroll while allowing vertical scrolling to reach their surrounding pane. No wheel interception or system browser settings are used.
- Resource/detail tabs support arrows, Home/End, and resource-tab deletion. Closing tabs restores focus. Application typography excludes terminal internals; shell controls wrap in narrow panes.

## Automated validation

- Frontend: 25 Vitest/React Testing Library cases with controlled IPC and terminal adapters cover shell races, background output, inactive tab closure, input ordering, Unicode bytes, resize bursts, stale refresh/log/rollout callbacks, confirmation invalidation, log following, keyboard navigation, and terminal clipboard shortcuts.
- Rust: 5 tests cover pending-setup cancellation, timeout, registration cleanup, duplicate IDs, and isolation between sessions.
- Lint, frontend production build, Rust check and Rust tests are required in CI before installer publication. CI uses Node 22.
- Local Rust compilation exhausted disk with default debug artifacts. Generated debug output was cleaned, and checks were rerun with `CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_INCREMENTAL=0`.

## Acceptance still required before release

- Native WebView2: mouse wheel, precision touchpad, keyboard and scrollbar scrolling at both edges in tables, menus, detail panes, logs, YAML, and terminals. Confirm no stretch or parent scrolling, with intentional horizontal scrolling preserved.
- Native Windows: 920×640 and larger windows, light/dark appearance, display scaling, keyboard focus, resize and maximize. The existing layout and muted gold appearance are preserved by the source changes, but native visual acceptance has not been completed.
- Disposable live Kubernetes workload: cancel during exec setup, rapid reconnect, context switching, background output, split Unicode, paste/Ctrl+C, resize, normal/nonzero exits, denied exec, missing shell, and interrupted network. `kubectl` is unavailable in this environment; no live workload was created.

Installer packaging remains pending: the local `npm run build -- --bundles nsis` execution was rejected by the approval step. Any installer produced from this branch remains a validation candidate until the manual checks pass. No release tag or publication is performed by this change.
