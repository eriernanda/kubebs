import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { navigateTabs } from "./tab-navigation";
afterEach(cleanup);
it("supports arrows, Home and End with focus and activation", () => {
  const select = vi.fn();
  render(<div role="tablist" onKeyDown={navigateTabs}>{["one", "two", "three"].map((name) => <button key={name} role="tab" onClick={() => select(name)}>{name}</button>)}</div>);
  const tabs = screen.getAllByRole("tab");
  fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
  expect(document.activeElement).toBe(tabs[2]); expect(select).toHaveBeenLastCalledWith("three");
  fireEvent.keyDown(tabs[2], { key: "Home" }); expect(document.activeElement).toBe(tabs[0]);
  fireEvent.keyDown(tabs[0], { key: "End" }); expect(document.activeElement).toBe(tabs[2]);
});
