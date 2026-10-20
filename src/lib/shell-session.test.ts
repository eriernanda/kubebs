import { describe, expect, it, vi } from "vitest";
import { ShellSession, type ShellAdapter } from "./shell-session";
import type { ShellOutput } from "./kubernetes";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const callbacks: Array<(event: ShellOutput) => void> = [];
  const setups: ReturnType<typeof deferred>[] = [];
  const adapter = {
    openShell: vi.fn<ShellAdapter["openShell"]>((...args) => { callbacks.push(args[6]); const setup = deferred(); setups.push(setup); return setup.promise; }),
    closeShell: vi.fn<ShellAdapter["closeShell"]>().mockResolvedValue(),
    sendShellInput: vi.fn<ShellAdapter["sendShellInput"]>().mockResolvedValue(),
    resizeShell: vi.fn<ShellAdapter["resizeShell"]>().mockResolvedValue(),
  };
  const output = vi.fn();
  const session = new ShellSession(adapter, output);
  const connect = () => session.connect({ name: "pod", namespace: "test", container: "app" }, 80, 24);
  const emit = (index: number, values: Partial<ShellOutput>) => callbacks[index]({ sessionId: adapter.openShell.mock.calls[index][0], bytes: [], closed: false, ...values });
  return { adapter, output, session, setups, connect, emit };
}
describe("shell lifecycle", () => {
  it("cancels pending setup and ignores its eventual success", async () => {
    const h = harness();
    const connecting = h.connect();
    expect(h.session.getSnapshot().state).toBe("connecting");
    h.session.input("never send before connected");
    await h.session.close();
    h.setups[0].resolve(); await connecting;
    expect(h.session.getSnapshot().state).toBe("closed");
    expect(h.adapter.closeShell).toHaveBeenCalledWith(h.adapter.openShell.mock.calls[0][0]);
    expect(h.adapter.sendShellInput).not.toHaveBeenCalled();
  });
  it("ignores old termination, output and setup failure after reconnect", async () => {
    const h = harness();
    const old = h.connect(); await h.session.close();
    const next = h.connect(); h.setups[1].resolve(); await next;
    h.emit(0, { closed: true, reason: "Shell failed" });
    h.emit(0, { bytes: [65] });
    h.setups[0].reject({ kind: "connection", message: "old failure" }); await old;
    expect(h.session.getSnapshot().state).toBe("connected");
    expect(h.output).not.toHaveBeenCalled();
  });
  it("does not resurrect an already terminated connection when setup resolves", async () => {
    const h = harness(); const pending = h.connect();
    h.emit(0, { closed: true, reason: "Shell exited", exitCode: 0 });
    h.setups[0].resolve(); await pending;
    expect(h.session.getSnapshot().state).toBe("closed");
  });
  it("preserves split Unicode bytes without decoding individual chunks", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    h.emit(0, { bytes: [0xf0, 0x9f] }); h.emit(0, { bytes: [0x98, 0x80] });
    expect(h.output.mock.calls.map(([bytes]) => Array.from(bytes))).toEqual([[0xf0, 0x9f], [0x98, 0x80]]);
  });
  it("serializes typing, paste and Ctrl+C", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    const write = deferred(); h.adapter.sendShellInput.mockReturnValueOnce(write.promise);
    h.session.input("echo "); h.session.input("paste\r"); h.session.input("\x03");
    await Promise.resolve(); expect(h.adapter.sendShellInput).toHaveBeenCalledTimes(1);
    write.resolve(); await vi.waitFor(() => expect(h.adapter.sendShellInput).toHaveBeenCalledTimes(3));
    expect(h.adapter.sendShellInput.mock.calls.map(([, data]) => data)).toEqual(["echo ", "paste\r", "\x03"]);
  });
  it("never replays queued input into a new attempt", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    const write = deferred(); h.adapter.sendShellInput.mockReturnValueOnce(write.promise);
    h.session.input("first"); h.session.input("discard"); await Promise.resolve();
    await h.session.close(); const next = h.connect(); h.setups[1].resolve(); await next;
    write.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.adapter.sendShellInput).toHaveBeenCalledTimes(1);
  });
  it("coalesces resize bursts to the latest pending size", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    const resize = deferred(); h.adapter.resizeShell.mockReturnValueOnce(resize.promise);
    h.session.resize(90, 25); h.session.resize(100, 30); h.session.resize(120, 40);
    resize.resolve(); await vi.waitFor(() => expect(h.adapter.resizeShell).toHaveBeenCalledTimes(2));
    expect(h.adapter.resizeShell.mock.calls.map(([, cols, rows]) => [cols, rows])).toEqual([[90, 25], [120, 40]]);
  });
  it.each(["Permission denied", "/bin/sh: not found", "Network interrupted"])("reports setup failure: %s", async (message) => {
    const h = harness(); const pending = h.connect();
    h.setups[0].reject({ kind: "connection", message }); await pending;
    expect(h.session.getSnapshot()).toMatchObject({ state: "error", error: { message } });
    expect(h.adapter.openShell).toHaveBeenCalledTimes(1);
  });
  it("reports nonzero exit and transport termination", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    h.emit(0, { closed: true, exitCode: 127, reason: "Shell failed: command missing" });
    expect(h.session.getSnapshot()).toMatchObject({ state: "error", reason: "Shell failed: command missing" });
  });
  it("uses structured transport failure even without an exit code", async () => {
    const h = harness(); const pending = h.connect(); h.setups[0].resolve(); await pending;
    h.emit(0, { closed: true, failed: true, reason: "Socket closed unexpectedly" });
    expect(h.session.getSnapshot()).toMatchObject({ state: "error", error: { message: "Socket closed unexpectedly" } });
  });
  it("disposal cancels setup and suppresses late callbacks", async () => {
    const h = harness(); const pending = h.connect(); h.session.dispose();
    h.emit(0, { bytes: [1] }); h.setups[0].resolve(); await pending;
    expect(h.adapter.closeShell).toHaveBeenCalledTimes(1);
    expect(h.output).not.toHaveBeenCalled();
    await h.connect(); expect(h.adapter.openShell).toHaveBeenCalledTimes(1);
  });
});
