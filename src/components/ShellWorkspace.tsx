import { useContext, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { PodSummary } from "../lib/kubernetes";
import { ShellWorkspaceContext, resourceKey } from "../lib/shell-workspace";

export function PersistentShell({ selection, pod, relatedPods }: { selection: { kind: string; name: string; namespace: string }; pod: PodSummary | null; relatedPods: PodSummary[] }) {
  const workspace = useContext(ShellWorkspaceContext)!;
  const entry = workspace.get(resourceKey(selection));
  const snapshot = useSyncExternalStore(entry.session.subscribe, entry.session.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [hasSelection, setHasSelection] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useLayoutEffect(() => {
    const update = () => { setHasSelection(entry.terminal.hasSelection()); setCopyStatus(""); };
    update();
    const subscription = entry.terminal.onSelectionChange(update);
    return () => subscription.dispose();
  }, [entry]);
  const locked = ["connecting", "connected", "closing"].includes(snapshot.state);
  const pods = selection.kind === "pod" ? (pod ? [pod] : []) : relatedPods;
  const podName = locked ? snapshot.target?.name ?? "" : entry.selectedPod || (pods.length === 1 ? pods[0].name : "");
  const targetPod = pods.find((item) => item.name === podName);
  const containers = targetPod?.containers ?? [];
  const container = locked ? snapshot.target?.container ?? "" : entry.selectedContainer || (containers.length === 1 ? containers[0].name : "");
  useLayoutEffect(() => {
    const node = host.current!;
    node.append(entry.element);
    const fit = () => {
      if (!node.clientWidth || !node.clientHeight) return;
      entry.fit.fit();
      entry.session.resize(entry.terminal.cols, entry.terminal.rows);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => { observer.disconnect(); entry.element.remove(); };
  }, [entry]);
  useLayoutEffect(() => {
    entry.terminal.options.disableStdin = snapshot.state !== "connected";
    if (snapshot.state === "connected") { entry.fit.fit(); entry.session.resize(entry.terminal.cols, entry.terminal.rows); entry.terminal.focus(); }
  }, [entry, snapshot.state]);
  return <div className="shell-panel">
    <div className="shell-toolbar">
      <select aria-label="Select Pod for shell" disabled={locked} value={podName} onChange={(event) => { entry.selectedPod = event.target.value; entry.selectedContainer = ""; redraw(); }}>
        <option value="">Choose Pod</option>{pods.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <select aria-label="Select container for shell" disabled={locked} value={container} onChange={(event) => { entry.selectedContainer = event.target.value; redraw(); }}>
        <option value="">Choose container</option>{containers.map((item) => <option key={item.name}>{item.name}</option>)}
      </select>
      <span className="shell-target-label">{snapshot.target && locked ? `${snapshot.target.name} · ${snapshot.target.container}` : podName || "No Pod selected"}</span>
      <span role="status">{snapshot.state}</span>
      <button className="small-action" disabled={!hasSelection} title="Copy selection (Ctrl+Shift+C); right-click selected text also copies" onClick={() => { void entry.copySelection().then(() => setCopyStatus("Copied")).catch(() => setCopyStatus("Copy failed. Check clipboard access.")); }}>Copy selection</button>
      {locked ? <button className="small-action" disabled={snapshot.state === "closing"} onClick={() => void entry.session.close()}>{snapshot.state === "connecting" ? "Cancel" : "Disconnect"}</button> : <button className="small-action" disabled={!targetPod || !containers.some((item) => item.name === container)} onClick={() => { entry.fit.fit(); void entry.session.connect({ name: podName, namespace: selection.namespace, container }, entry.terminal.cols, entry.terminal.rows); }}>{snapshot.state === "idle" ? "Connect" : "Reconnect"}</button>}
    </div>
    {copyStatus && <div role="status">{copyStatus}</div>}
    {snapshot.error && <div className="shell-error" role="alert">{snapshot.error.message}</div>}
    {snapshot.reason && <div role="status">{snapshot.reason}</div>}
    <div className="shell-terminal-host" ref={host} role="application" aria-label="Interactive container terminal" onClick={() => entry.terminal.focus()} />
  </div>;
}
