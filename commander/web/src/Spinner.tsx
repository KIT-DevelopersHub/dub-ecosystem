// Small inline progress spinner for in-flight actions (phase反映中 etc.). Keyframes are
// injected once (inline style can't hold @keyframes); safe to mount many spinners.
import { t } from "./lib/theme.ts";

let injected = false;
function ensureKeyframes() {
  if (injected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.textContent =
    "@keyframes cmdr-spin{to{transform:rotate(360deg)}}" +
    "@keyframes cmdr-pulse{0%,100%{opacity:.45}50%{opacity:.9}}";
  document.head.appendChild(el);
  injected = true;
}

export function Spinner({ size = 14, color = t.warning }: { size?: number; color?: string }) {
  ensureKeyframes();
  return (
    <span
      aria-hidden
      data-testid="spinner"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "cmdr-spin 0.7s linear infinite",
        flex: "0 0 auto",
      }}
    />
  );
}

/** A thin shimmering progress bar for an indeterminate in-flight action. */
export function ProgressBar({ color = t.warning }: { color?: string }) {
  ensureKeyframes();
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        height: 3,
        borderRadius: 999,
        background: color,
        animation: "cmdr-pulse 1.1s ease-in-out infinite",
      }}
    />
  );
}
