import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { kubernetes, type PodSummary, type DeploymentSummary } from "./lib/kubernetes";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isMaximized: async () => false, onResized: async () => () => {} }) }));
vi.mock("./lib/kubernetes", async (original) => {
  const actual = await original<typeof import("./lib/kubernetes")>();
  return { ...actual, kubernetes: Object.fromEntries(Object.keys(actual.kubernetes).map((key) => [key, vi.fn().mockResolvedValue([])])) };
});
const pods = ["pod-one", "pod-two"].map((name) => ({ name, namespace: "test", status: "Running", readyContainers: 1, totalContainers: 1, restarts: 0, labels: { app: "demo" }, containers: [{ name: "app", image: "test", ready: true, restartCount: 0, resources: {} }] })) as PodSummary[];
const deployment: DeploymentSummary = { name: "demo", namespace: "test", desired: 1, ready: 1, available: 1, updated: 1, selector: { app: "demo" } };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  for (const method of Object.values(kubernetes)) vi.mocked(method).mockReset().mockResolvedValue([] as never);
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.mocked(kubernetes.restoreKubeconfig).mockResolvedValue(["a", "b"].map((name) => ({ name, cluster: name, server: "test", isCurrent: name === "a" })));
  vi.mocked(kubernetes.connect).mockImplementation(async (context) => ({ context, server: "test", namespace: "test" }));
  vi.mocked(kubernetes.namespaces).mockResolvedValue([{ name: "test", status: "Active" }]);
  vi.mocked(kubernetes.pods).mockResolvedValue(pods);
  vi.mocked(kubernetes.pod).mockImplementation(async (name) => pods.find((pod) => pod.name === name)!);
  vi.mocked(kubernetes.deployments).mockResolvedValue([deployment, { ...deployment, name: "demo-two" }]);
  vi.mocked(kubernetes.deployment).mockImplementation(async (name) => ({ ...deployment, name }));
  vi.mocked(kubernetes.relatedPods).mockResolvedValue(pods);
  vi.mocked(kubernetes.yaml).mockResolvedValue("kind: Pod");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function mount() {
  render(<App />);
  await waitFor(() => expect(kubernetes.pods).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /^Workloads/ }));
  await screen.findByText("demo");
}
async function openResource(name: string) {
  fireEvent.click(screen.getByText(name).closest("tr")!);
  await screen.findByRole("heading", { name });
  await waitFor(() => expect(screen.queryByText("Loading resource details")).toBeNull());
}
it("ignores manual-refresh node results after a context switch", async () => {
  await mount();
  let finish!: (items: Awaited<ReturnType<typeof kubernetes.nodes>>) => void;
  vi.mocked(kubernetes.nodes).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByLabelText("Refresh workloads"));
  fireEvent.click(screen.getByLabelText("Choose Kubernetes context or config file"));
  fireEvent.click(screen.getAllByRole("menuitem").find((item) => item.getAttribute("title") === "b")!);
  await waitFor(() => expect(kubernetes.connect).toHaveBeenLastCalledWith("b"));
  await screen.findByText("demo");
  await act(async () => finish([{ name: "obsolete-node", ready: true, version: "test", conditions: [] }]));
  fireEvent.click(screen.getByRole("button", { name: /^Nodes/ }));
  expect(screen.queryByText("obsolete-node")).toBeNull();
});
it("ignores a previous resource's log failure", async () => {
  await mount(); await openResource("demo");
  let reject!: (error: unknown) => void;
  vi.mocked(kubernetes.streamLogs).mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
  await waitFor(() => expect(kubernetes.streamLogs).toHaveBeenCalled());
  await openResource("demo-two");
  await act(async () => reject({ kind: "connection", message: "obsolete log failure" }));
  expect(screen.queryByText("obsolete log failure")).toBeNull();
});
it("invalidates rollout confirmation when the resource changes", async () => {
  await mount(); await openResource("demo");
  fireEvent.click(screen.getByRole("button", { name: "Restart rollout" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  await openResource("demo-two");
  expect(screen.queryByText("Restart deployment rollout?")).toBeNull();
  expect(kubernetes.restartDeployment).not.toHaveBeenCalled();
});
it("binds rollout to its original context and ignores stale completion", async () => {
  await mount(); await openResource("demo");
  let reject!: (error: unknown) => void;
  vi.mocked(kubernetes.restartDeployment).mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  fireEvent.click(screen.getByRole("button", { name: "Restart rollout" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restart rollout" }));
  expect(kubernetes.restartDeployment).toHaveBeenCalledWith("demo", "test", "a");
  await openResource("demo-two");
  await act(async () => reject({ kind: "api", message: "obsolete rollout failure" }));
  expect(screen.queryByText("obsolete rollout failure")).toBeNull();
});
