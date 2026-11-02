// ⌘⇧D / Ctrl+Shift+D toggles the staging debug menu (ignored while an IME is composing).
import { useEffect, useRef } from "react";

export function isDebugShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing">): boolean {
  return !e.isComposing && e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d";
}

export function useStagingDebugShortcut(onToggle: () => void): void {
  const ref = useRef(onToggle);
  ref.current = onToggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isDebugShortcut(e)) return;
      e.preventDefault();
      ref.current();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);
}
