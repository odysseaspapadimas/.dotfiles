import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// BB currently exposes actions beside Submit, but no model-accessory slot.
// Keep a scope-local portal beside the real model button; never touch its handlers.
export function BesideModel({ children }: { children: ReactNode }) {
  const origin = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const marker = origin.current;
    if (!marker) return;
    const root = marker.closest("[data-app-composer]");
    if (!root) return;
    const accessory = document.createElement("span");
    accessory.className = "pi-codex-usage-accessory";
    accessory.dataset.piCodexUsageAccessory = "";
    const place = () => {
      const button = root.querySelector('button[aria-label^="Provider, model and reasoning"]');
      if (!button || button.closest("[data-app-composer]") !== root) {
        if (accessory.isConnected) { accessory.remove(); setContainer(null); }
        return;
      }
      if (button.nextElementSibling !== accessory) button.after(accessory);
      setContainer(current => current === accessory ? current : accessory);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); accessory.remove(); };
  }, []);
  return <><span ref={origin} className="pi-codex-usage-origin">{container ? null : children}</span>{container && createPortal(children, container)}</>;
}
