# Infra

A Windows-first Kubernetes desktop client built with Tauri, React, TypeScript, and Rust.

## Development

Install Node.js, Rust, and the Windows C++ build tools required by Tauri. Then run:

```powershell
npm install
npm run tauri dev
```

Create a Windows installer with:

```powershell
npm run tauri build
```

When you open a kubeconfig file, Infra remembers its path in `%APPDATA%\dev.infra.kubernetes\selected-kubeconfig-path` and reloads it the next time the app starts. The kubeconfig itself stays in its original location. Contexts can be switched inside the app. Credentials remain in the native process; Infra does not upload them or write context changes back to kubeconfig.

The v0.1 workflow is read-only: inspect Pods and Deployments, trace Deployments to Pods, review related events and YAML, and stream Pod logs. Cluster data is never replaced with demo data when a request fails. v0.2.0 adds resource tabs, YAML search/highlighting, Deployment rollout controls, an interactive Pod shell, Nodes, and CPU/memory metrics.

## Checks

```powershell
npm run lint
npm run build
```
