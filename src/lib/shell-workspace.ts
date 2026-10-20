import { createContext } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { kubernetes } from "./kubernetes";
import { ShellSession } from "./shell-session";

export class TerminalSession {
  terminal = new Terminal({ cursorBlink: true, disableStdin: true, fontSize: 12, fontFamily: '"Cascadia Code", Consolas, monospace', scrollback: 3000, theme: { background: "#0d1110", foreground: "#d7e0dc", cursor: "#d3a96d", selectionBackground: "#46534c" } });
  fit = new FitAddon();
  element = document.createElement("div");
  session: ShellSession;
  selectedPod = "";
  selectedContainer = "";
  constructor(context?: string) {
    this.session = new ShellSession({
      ...kubernetes,
      openShell: (id, name, namespace, container, cols, rows, onOutput) => kubernetes.openShell(id, name, namespace, container, cols, rows, onOutput, context),
    }, (bytes) => this.terminal.write(bytes));
    this.element.className = "shell-terminal-surface";
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.element);
    this.terminal.onData((data) => this.session.input(data));
    this.element.addEventListener("contextmenu", (event) => {
      if (!this.terminal.hasSelection()) return;
      event.preventDefault();
      void this.copySelection().catch(() => this.terminal.writeln("\r\nClipboard copy failed. Try Ctrl+Shift+C again."));
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        if (event.type === "keydown") void this.copySelection().catch(() => this.terminal.writeln("\r\nClipboard copy failed."));
        return false;
      }
      if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "v") return true;
      event.preventDefault();
      const snapshot = this.session.getSnapshot();
      if (snapshot.state === "connected") {
        if (!navigator.clipboard?.readText) { this.terminal.writeln("\r\nClipboard access is unavailable."); return false; }
        void navigator.clipboard.readText().then((text) => {
          if (this.session.getSnapshot() === snapshot) this.terminal.paste(text);
        }).catch(() => this.terminal.writeln("\r\nClipboard paste failed."));
      }
      return false;
    });
  }
  async copySelection() {
    const text = this.terminal.getSelection();
    if (!text) return;
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(text);
  }
  dispose() { this.session.dispose(); this.terminal.dispose(); this.element.remove(); }
}

export class ShellWorkspace {
  private terminals = new Map<string, TerminalSession>();
  constructor(private context?: string) {}
  get(key: string) {
    let item = this.terminals.get(key);
    if (!item) { item = new TerminalSession(this.context); this.terminals.set(key, item); }
    return item;
  }
  retain(keys: string[]) { for (const [key, item] of this.terminals) if (!keys.includes(key)) { item.dispose(); this.terminals.delete(key); } }
  clear() { for (const item of this.terminals.values()) item.dispose(); this.terminals.clear(); }
}
export const ShellWorkspaceContext = createContext<ShellWorkspace | null>(null);
export const resourceKey = (selection: { kind: string; namespace: string; name: string }) => `${selection.kind}:${selection.namespace}/${selection.name}`;
