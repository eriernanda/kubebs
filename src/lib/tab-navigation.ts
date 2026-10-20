import type { KeyboardEvent } from "react";

export function navigateTabs(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  if (target.getAttribute("role") !== "tab") return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(target as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case "ArrowRight": next = (index + 1) % tabs.length; break;
    case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
    case "Home": next = 0; break;
    case "End": next = tabs.length - 1; break;
    case "Delete":
      target.closest(".resource-tab")?.querySelector<HTMLButtonElement>(".resource-tab-close")?.click();
      event.preventDefault();
      return;
    default: return;
  }
  event.preventDefault();
  tabs[next]?.click();
  tabs[next]?.focus();
}

export function restoreResourceFocus() {
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLButtonElement>('[aria-label="Open resources"] [role="tab"][aria-selected="true"]') ?? document.querySelector<HTMLButtonElement>('[aria-label="Refresh workloads"]');
    target?.focus();
  });
}
