import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PersistentShell } from "./ShellWorkspace";
import { ShellWorkspace, ShellWorkspaceContext, resourceKey } from "../lib/shell-workspace";
import { kubernetes, type PodSummary } from "../lib/kubernetes";

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24;
  write = vi.fn(); writeln = vi.fn(); dispose = vi.fn(); focus = vi.fn(); paste = vi.fn();
  getSelection = vi.fn(() => ""); hasSelection = vi.fn(() => false);
  onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
  loadAddon() {} open(element: HTMLElement) { element.textContent = "terminal"; }
  onData() {} attachCustomKeyEventHandler = vi.fn();
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("../lib/kubernetes", async (original) => {
  const actual = await original<typeof import("../lib/kubernetes")>();
  return { ...actual, kubernetes: { ...actual.kubernetes, openShell: vi.fn().mockResolvedValue(undefined), closeShell: vi.fn().mockResolvedValue(undefined), resizeShell: vi.fn().mockResolvedValue(undefined) } };
});
const pod = { name: "one", namespace: "test", containers: [{ name: "app" }, { name: "sidecar" }] } as PodSummary;
const selection = { kind: "pod", name: "one", namespace: "test" };
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("persistent resource terminals", () => {
  it("copies selected text with Ctrl+Shift+C while leaving Ctrl+C to the shell", async () => {
    const workspace = new ShellWorkspace(); const entry = workspace.get("copy");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.mocked(entry.terminal.getSelection).mockReturnValue("selected output");
    const handler = vi.mocked(entry.terminal.attachCustomKeyEventHandler).mock.calls[0][0];
    expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(handler(new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }))).toBe(false);
    await Promise.resolve(); expect(writeText).toHaveBeenCalledWith("selected output");
    handler(new KeyboardEvent("keyup", { key: "C", ctrlKey: true, shiftKey: true }));
    expect(writeText).toHaveBeenCalledTimes(1);
    workspace.clear();
  });
  it("copies xterm selection on right-click without sending terminal input", async () => {
    const workspace = new ShellWorkspace(); const entry = workspace.get("copy");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.mocked(entry.terminal.hasSelection).mockReturnValue(true);
    vi.mocked(entry.terminal.getSelection).mockReturnValue("selected output");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    entry.element.dispatchEvent(event);
    await Promise.resolve(); expect(writeText).toHaveBeenCalledWith("selected output");
    expect(event.defaultPrevented).toBe(true);
    workspace.clear();
  });
  it("retains its terminal and background output across unmount/remount", async () => {
    const workspace = new ShellWorkspace("cluster-a");
    const view = () => <ShellWorkspaceContext.Provider value={workspace}><PersistentShell selection={selection} pod={pod} relatedPods={[]} /></ShellWorkspaceContext.Provider>;
    const mounted = render(view());
    fireEvent.change(screen.getByLabelText("Select container for shell"), { target: { value: "app" } });
    await act(async () => fireEvent.click(screen.getByText("Connect")));
    const entry = workspace.get(resourceKey(selection));
    mounted.unmount();
    expect(entry.terminal.dispose).not.toHaveBeenCalled();
    const args = vi.mocked(kubernetes.openShell).mock.calls[0];
    expect(args[7]).toBe("cluster-a");
    args[6]({ sessionId: args[0], bytes: [65], closed: false });
    expect(entry.terminal.write).toHaveBeenCalledWith(new Uint8Array([65]));
    render(view());
    expect(workspace.get(resourceKey(selection))).toBe(entry);
    expect(screen.getByLabelText("Select container for shell")).toHaveProperty("disabled", true);
    expect(screen.getByText("connected")).toBeTruthy();
    workspace.clear();
  });
  it("closes an inactive resource tab while preserving the active session", async () => {
    const workspace = new ShellWorkspace();
    const first = workspace.get("first"), second = workspace.get("second");
    await first.session.connect({ name: "one", namespace: "test", container: "app" }, 80, 24);
    await second.session.connect({ name: "two", namespace: "test", container: "app" }, 80, 24);
    workspace.retain(["second"]);
    expect(first.terminal.dispose).toHaveBeenCalledTimes(1);
    expect(second.session.getSnapshot().state).toBe("connected");
    expect(kubernetes.closeShell).toHaveBeenCalledTimes(1);
    workspace.clear();
  });
  it("cancels pending sessions when the connection workspace clears", async () => {
    const workspace = new ShellWorkspace();
    let finish!: () => void;
    vi.mocked(kubernetes.openShell).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const entry = workspace.get("first");
    const pending = entry.session.connect({ name: "one", namespace: "test", container: "app" }, 80, 24);
    workspace.clear(); finish(); await pending;
    expect(entry.session.getSnapshot().state).toBe("closed");
    expect(entry.terminal.dispose).toHaveBeenCalled();
  });
});
