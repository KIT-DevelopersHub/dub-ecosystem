// Commander — the Dub app wrapper around @dub/commander-web's CommanderWorkspace (SoT: all
// logic lives in commander/web; this only supplies shell chrome and the transport).
//
// Two transports, picked by where the page is served from:
//   - loopback (127.0.0.1 / localhost): the workspace's default clients talk to the local
//     daemon / commander-service directly, as before;
//   - anywhere else (the deployed Dub app): everything goes through the commander-relay
//     WebSocket. The operator's PC keeps an agent connected to the same relay, so the board,
//     chats and runs are the PC's real, live data — no tunnel and no token in the browser.
// Admin-only (identity:admin + app:commander:view), member-hidden.
import { useEffect, useMemo, useState } from "react";
import { Badge, Card, PageHeader, Stack } from "@dub/ui";
import {
  CommanderWorkspace,
  HttpCommanderApi,
  HttpCommanderClient,
  RelayConnection,
  type RelayStatus,
  type RelayTicket,
} from "@dub/commander-web";
import { useCommanderShellApi } from "./CommanderProvider.tsx";

const RELAY_TICKET_PATH = "/api/v1/commander/relay/ticket" as const;

export function isLoopbackHost(hostname: string): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostname);
}

const STATUS_VIEW: Record<RelayStatus, { tone: "success" | "warning" | "danger" | "neutral"; label: string; detail: string }> = {
  connecting: { tone: "neutral", label: "接続中", detail: "あなたの PC の Commander に接続しています。" },
  online: {
    tone: "success",
    label: "PC と接続中",
    detail: "あなたの PC で動いている Commander の実データを、リアルタイムに表示・操作しています。",
  },
  agent_offline: {
    tone: "warning",
    label: "PC がオフライン",
    detail: "中継サーバーには繋がっていますが、PC 側の中継エージェントが接続していません。PC で Commander を起動してください（commander/README.md の「別端末から使う」）。",
  },
  disconnected: {
    tone: "danger",
    label: "中継サーバーに接続できません",
    detail: "数秒おきに自動で再接続します。続く場合は、ログインし直すか管理者権限を確認してください。",
  },
};

// 停止時の案内はボード側(daemon-down-hint)が出すので、ここは1行の説明に留める。
const NOTE =
  "あなたのマシン上のローカル Commander（127.0.0.1 の daemon / service）に接続します。起動手順: commander/README.md";

export function CommanderScreen(): JSX.Element {
  const shellApi = useCommanderShellApi();
  const relayMode = !isLoopbackHost(window.location.hostname) && shellApi !== null;

  const relay = useMemo(() => {
    if (!relayMode || !shellApi) return null;
    return new RelayConnection(() => shellApi.request<RelayTicket>({ method: "POST", path: RELAY_TICKET_PATH }));
  }, [relayMode, shellApi]);

  const [status, setStatus] = useState<RelayStatus>("connecting");
  useEffect(() => {
    if (!relay) return;
    const off = relay.onStatus(setStatus);
    relay.connect();
    return () => {
      off();
      relay.close();
    };
  }, [relay]);

  const clients = useMemo(() => {
    if (!relay) return null;
    // Base URLs are placeholders: the relay forwards only the path, to the PC's loopback.
    return {
      client: new HttpCommanderClient("relay://daemon", undefined, relay.fetchFor("daemon"), relay.streamOpener()),
      api: new HttpCommanderApi("relay://service", undefined, relay.fetchFor("service")),
    };
  }, [relay]);

  const view = STATUS_VIEW[status];

  return (
    <Stack gap={4} testId="fe2-commander">
      {relayMode ? (
        <>
          <PageHeader title="Commander" />
          <Card testId="fe2-commander-relay-status">
            <Stack direction="row" gap={3} align="center" wrap>
              <Badge tone={view.tone} testId="fe2-commander-relay-badge">
                {view.label}
              </Badge>
              <span style={{ opacity: 0.85, fontSize: 13 }}>{view.detail}</span>
            </Stack>
          </Card>
        </>
      ) : (
        <PageHeader title="Commander" description={NOTE} testId="fe2-commander-daemon-note" />
      )}

      <div data-testid="fe2-commander-workspace">
        {/* Keyed by transport so switching never mixes loopback and relay state. */}
        {clients ? (
          // Slower board refresh over the relay: every poll wakes the relay's Durable Object
          // (free-tier duration). Live run logs still stream in real time.
          <CommanderWorkspace key="relay" client={clients.client} api={clients.api} boardPollMs={15_000} />
        ) : (
          <CommanderWorkspace key="loopback" />
        )}
      </div>
    </Stack>
  );
}
