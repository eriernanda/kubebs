import { errorFrom, kubernetes, type InfraError, type ShellOutput } from "./kubernetes";

export type ShellState = "idle" | "connecting" | "connected" | "closing" | "closed" | "error";
export interface ShellTarget { name: string; namespace: string; container: string }
export type ShellAdapter = Pick<typeof kubernetes, "openShell" | "closeShell" | "sendShellInput" | "resizeShell">;
export interface ShellSnapshot { state: ShellState; target?: ShellTarget; error?: InfraError; reason?: string }

export class ShellSession {
  private snapshot: ShellSnapshot = { state: "idle" };
  private listeners = new Set<() => void>();
  private attempt?: string;
  private writes = Promise.resolve();
  private resizePending?: [number, number];
  private resizing = false;
  private disposed = false;
  constructor(private adapter: ShellAdapter, private output: (bytes: Uint8Array) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(value: ShellSnapshot) { this.snapshot = value; this.listeners.forEach((listener) => listener()); }
  private fail(id: string | undefined, cause: unknown) {
    if (!id || this.attempt !== id) return;
    this.attempt = undefined;
    this.resizePending = undefined;
    this.update({ ...this.snapshot, state: "error", error: errorFrom(cause) });
    void this.adapter.closeShell(id).catch(() => undefined);
  }
  async connect(target: ShellTarget, cols: number, rows: number) {
    if (this.disposed || ["connecting", "connected", "closing"].includes(this.snapshot.state)) return;
    const id = crypto.randomUUID();
    this.attempt = id;
    this.writes = Promise.resolve();
    this.update({ state: "connecting", target });
    try {
      await this.adapter.openShell(id, target.name, target.namespace, target.container, cols, rows, (event: ShellOutput) => {
        if (this.attempt !== id || event.sessionId !== id || this.disposed) return;
        if (event.bytes.length) this.output(new Uint8Array(event.bytes));
        if (event.closed) {
          this.attempt = undefined;
          const failed = event.failed === true || (event.exitCode !== undefined && event.exitCode !== 0);
          this.update({ state: failed ? "error" : "closed", target, reason: event.reason, error: failed ? { kind: "connection", message: event.reason ?? `Shell exited with status ${event.exitCode}` } : undefined });
        }
      });
      if (this.attempt === id) this.update({ state: "connected", target });
    } catch (cause) {
      if (this.attempt !== id) return;
      this.attempt = undefined;
      this.update({ state: "error", target, error: errorFrom(cause) });
    }
  }
  async close() {
    const id = this.attempt;
    this.attempt = undefined;
    this.resizePending = undefined;
    if (!id) return;
    this.update({ ...this.snapshot, state: "closing" });
    try {
      await this.adapter.closeShell(id);
      if (!this.attempt) this.update({ ...this.snapshot, state: "closed", reason: "Disconnected" });
    } catch (cause) {
      if (!this.attempt) this.update({ ...this.snapshot, state: "error", error: errorFrom(cause) });
    }
  }
  input(data: string) {
    const id = this.attempt;
    if (!id || this.snapshot.state !== "connected") return;
    this.writes = this.writes.then(async () => {
      if (this.attempt !== id || this.snapshot.state !== "connected") return;
      await this.adapter.sendShellInput(id, data);
    }).catch((cause) => {
      this.fail(id, cause);
    });
  }
  resize(cols: number, rows: number) {
    if (this.snapshot.state !== "connected") return;
    this.resizePending = [cols, rows];
    if (!this.resizing) void this.flushResize();
  }
  private async flushResize() {
    this.resizing = true;
    const id = this.attempt;
    try {
      while (id && this.attempt === id && this.resizePending) {
        const size = this.resizePending;
        this.resizePending = undefined;
        await this.adapter.resizeShell(id, ...size);
      }
    } catch (cause) {
      this.fail(id, cause);
    } finally {
      this.resizing = false;
      if (this.resizePending && this.snapshot.state === "connected") void this.flushResize();
    }
  }
  dispose() { this.disposed = true; void this.close(); this.listeners.clear(); }
}
