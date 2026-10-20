import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LogsView } from "./App";
import type { PodSummary } from "./lib/kubernetes";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

afterEach(cleanup);
function props() {
  return {
    selection: { kind: "pod" as const, name: "one", namespace: "test" },
    pod: { name: "one", namespace: "test", containers: [{ name: "app" }] } as PodSummary,
    relatedPods: [], logPodName: "", setLogPodName: vi.fn(), logContainer: "app", setLogContainer: vi.fn(),
    logs: ["first", "second"], logSearch: "", setLogSearch: vi.fn(), showLogTimestamps: true,
    setShowLogTimestamps: vi.fn(), paused: false, logStatus: "Live", logPane: createRef<HTMLDivElement>(),
    error: null, onToggleLogs: vi.fn(),
  };
}
it("keeps history position on incoming output until Follow latest is clicked", () => {
  const values = props(); const view = render(<LogsView {...values} />);
  const pane = values.logPane.current!;
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 100 } });
  pane.scrollTop = 200; fireEvent.scroll(pane);
  view.rerender(<LogsView {...values} logs={[...values.logs, "third"]} />);
  expect(pane.scrollTop).toBe(200);
  fireEvent.click(screen.getByText("Follow latest"));
  expect(pane.scrollTop).toBe(1000);
});
it("distinguishes an ended or failed stream from a live or paused stream", () => {
  const values = props(); const view = render(<LogsView {...values} logStatus="Ended" />);
  expect(screen.getByRole("status").textContent).toBe("Ended");
  view.rerender(<LogsView {...values} logStatus="Error" />);
  expect(screen.getByRole("status").textContent).toBe("Error");
  view.rerender(<LogsView {...values} paused />);
  expect(screen.getByRole("status").textContent).toBe("Paused");
});
