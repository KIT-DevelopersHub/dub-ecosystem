// Shell-wide connection/failure banner (P1-3). Sits at the very top of the shell
// content, above every app, so a dropped network or an unreachable api-gateway is
// surfaced consistently everywhere — not just in chat (FE6). Non-invasive: it never
// blocks input, and it collapses to nothing when the connection is healthy.
//
// It is a persistent aria-live region (kept mounted, `hidden` when healthy) so a
// change to a failure state is announced to screen readers without a node being
// added/removed under them — the same aria-live作法 the design mandates.
import type { ConnectionHealth } from "../lib/useConnectionHealth.ts";

// User-facing copy per degraded state. "offline" = the user's own network is down;
// "unreachable" = network is up but the backend can't be reached (degraded, some
// actions may not be saved). Both are informational, not blocking.
const COPY: Record<Exclude<ConnectionHealth, "online">, string> = {
  offline: "インターネットに接続されていません。オフラインの可能性があります。",
  unreachable: "サーバーに接続できません。一部の操作が反映されない場合があります。",
};

export function ConnectionBanner({ health }: { health: ConnectionHealth }): JSX.Element {
  const message = health === "online" ? null : COPY[health];
  return (
    <div
      className="fe2-connection-banner"
      data-health={health}
      data-testid="fe2-connection-banner"
      role="status"
      aria-live="polite"
      hidden={message === null}
    >
      {message}
    </div>
  );
}
