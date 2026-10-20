# Kubebs

A Windows-first Kubernetes desktop client built with Tauri, React, TypeScript, and Rust.

## Development

Install Node.js 22.13 or newer, Rust, and the Windows C++ build tools required by Tauri. Then run:

```powershell
npm install
npm run tauri dev
```

Create a Windows installer with:

```powershell
npm run tauri build
```

When you open a kubeconfig file, Kubebs remembers its path in `%APPDATA%\dev.infra.kubernetes\selected-kubeconfig-path` and reloads it the next time the app starts. The kubeconfig itself stays in its original location. Contexts can be switched inside the app. Credentials remain in the native process; Kubebs does not upload them or write context changes back to kubeconfig.

The v0.1 workflow is read-only: inspect Pods and Deployments, trace Deployments to Pods, review related events and YAML, and stream Pod logs. Cluster data is never replaced with demo data when a request fails. v0.2.0 adds resource tabs, YAML search/highlighting, Deployment rollout controls, an interactive Pod shell, Nodes, and CPU/memory metrics.

## Checks

```powershell
npm run lint
npm test
npm run build:frontend
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

v0.2.2 preserves shell terminals and their 3,000-line scrollback per resource tab. Switching detail views keeps background output; closing a resource tab or changing cluster cancels its shells. Connections can be cancelled while opening and time out after 30 seconds. Reconnect is explicit and never replays commands.

Select terminal output and press **Ctrl+Shift+C**, click **Copy selection**, or right-click the selection to copy it. **Ctrl+C** still interrupts the remote command. Paste with **Ctrl+V** or **Ctrl+Shift+V**.

Logs report connection and termination state. Scrolling into history suspends following; **Follow latest** resumes it. App panes suppress edge bounce and scroll chaining while keeping normal wheel, touchpad, keyboard, and scrollbar behavior. See [release validation](RELEASE_NOTES.md) for remaining native acceptance checks.
