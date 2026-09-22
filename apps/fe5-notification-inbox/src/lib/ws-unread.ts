/// <reference lib="dom" />
// WebSocket LiveConnector for the unread badge. The chat realtime path proved that the
// DO-direct WebSocket (gateway-bypassing, ws-ticket authed) is the only transport that
// works here: EventSource cannot send the Authorization: Bearer header the gateway needs,
// and the api-gateway aborts any upstream stream at 15s. So the inbox badge subscribes the
// same way — a WS straight to the per-user InboxRoom DO.
//
// This satisfies the existing `LiveConnector` contract (lib/unread-live.ts), so
// `createReconnectingUnreadLive` drives reconnect/backoff unchanged. Each (re)connect
// fetches a FRESH ws-ticket (tickets are ~60s) then opens the WS. The server frame is a
// lightweight "inbox-changed" signal; on it we refetch the AUTHORITATIVE unread count
// (which respects admin-audience visibility) and push that to the badge.
import type { LiveConnector, LiveConnection, LiveHandlers } from "./unread-live";

export interface WsTicket {
  ticket: string;
  doUrl: string;
}

export interface WsUnreadConnectorConfig {
  // Re-fetch a fresh ws-ticket on each connect (GET /notifications/inbox/ws-ticket).
  getTicket: () => Promise<WsTicket>;
  // Fetch the authoritative unread count (GET /notifications/inbox/unread-count).
  fetchCount: () => Promise<number>;
  // Injectable for tests / SSR guards (defaults to the global WebSocket).
  wsFactory?: (url: string) => WebSocket;
}

type WsLike = Pick<WebSocket, "close" | "onopen" | "onmessage" | "onerror" | "onclose">;

export function createWsUnreadConnector(config: WsUnreadConnectorConfig): LiveConnector {
  return (handlers: LiveHandlers): LiveConnection => {
    let ws: WsLike | null = null;
    let closed = false;

    // Refetch the authoritative count and push it to the badge. Swallow errors — the
    // reconciling poller (useUnreadCount) covers a transient failure.
    const refreshCount = (): void => {
      config
        .fetchCount()
        .then((count) => {
          if (!closed) handlers.onCount(count);
        })
        .catch(() => {
          /* keep last value; poller reconciles */
        });
    };

    // Open asynchronously (ticket fetch is async); `connect` must return a handle now.
    void (async () => {
      let ticket: WsTicket;
      try {
        ticket = await config.getTicket();
      } catch (err) {
        if (!closed) handlers.onError?.(err);
        return;
      }
      if (closed) return;
      const Ctor =
        config.wsFactory ??
        ((url: string) => new (globalThis as { WebSocket: new (u: string) => WebSocket }).WebSocket(url));
      if (!config.wsFactory && typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
        handlers.onError?.(new Error("WebSocket is not available"));
        return;
      }
      const url = `${ticket.doUrl}${ticket.doUrl.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket.ticket)}`;
      let socket: WebSocket;
      try {
        socket = Ctor(url);
      } catch (err) {
        handlers.onError?.(err);
        return;
      }
      ws = socket;
      socket.onopen = () => {
        handlers.onOpen?.();
        // Reconcile immediately on (re)connect: catch anything that changed while offline.
        refreshCount();
      };
      socket.onmessage = (ev: MessageEvent) => {
        // Any server frame ("inbox-changed") means the inbox changed -> refetch the count.
        // "pong" (liveness) is harmless to treat the same way, but we filter it to avoid a
        // needless request.
        if (typeof ev.data === "string" && ev.data === "pong") return;
        refreshCount();
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        // Signal the reconnecting source to back off and reconnect (with a fresh ticket).
        if (!closed) handlers.onError?.(new Error("inbox ws closed"));
      };
    })();

    return {
      close() {
        closed = true;
        if (ws) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }
      },
    };
  };
}
