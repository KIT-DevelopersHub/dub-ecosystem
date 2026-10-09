// Commander — the Dub app wrapper around @dub/commander-web's CommanderWorkspace, the same
// body (ボード / Dubに聞く / Dubを操作) the standalone page renders (SoT: all logic lives in
// commander/web; this only supplies shell chrome). It drives the operator's commander-daemon /
// commander-service: by default on 127.0.0.1 (same machine only), or — once a remote
// connection is saved on this device — through the Cloudflare Tunnel that fronts them
// (commander/tunnel-up.sh), so it works from any device while the operator's PC is up.
// Admin-only (identity:admin + app:commander:view), member-hidden.
import { useMemo, useState } from "react";
import { Badge, Button, Card, FormField, Icon, PageHeader, Stack, TextField } from "@dub/ui";
import {
  CommanderWorkspace,
  clientsFor,
  isAllowedUrl,
  loadConnection,
  saveConnection,
  type CommanderConnection,
} from "@dub/commander-web";

type ProbeState = "idle" | "checking" | "ok" | "unauthorized" | "unreachable";

const PROBE_LABEL: Record<Exclude<ProbeState, "idle">, string> = {
  checking: "確認中…",
  ok: "接続できました",
  unauthorized: "トークンが違います",
  unreachable: "接続できません（PC の Commander とトンネルが起動しているか確認）",
};

/** Hits an authenticated service route so a wrong token is told apart from "PC is down". */
async function probe(c: CommanderConnection): Promise<Exclude<ProbeState, "idle" | "checking">> {
  try {
    const res = await fetch(`${c.apiUrl.trim().replace(/\/+$/, "")}/tasks`, {
      headers: { "x-commander-token": c.token.trim() },
    });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return res.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

function ConnectionCard({
  saved,
  onChange,
}: {
  saved: CommanderConnection | null;
  onChange: (c: CommanderConnection | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [daemonUrl, setDaemonUrl] = useState(saved?.daemonUrl ?? "");
  const [apiUrl, setApiUrl] = useState(saved?.apiUrl ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [state, setState] = useState<ProbeState>("idle");

  const draft = { daemonUrl, apiUrl, token };
  const daemonBad = daemonUrl !== "" && !isAllowedUrl(daemonUrl);
  const apiBad = apiUrl !== "" && !isAllowedUrl(apiUrl);
  const canSave = isAllowedUrl(daemonUrl) && isAllowedUrl(apiUrl) && token.trim() !== "";

  const save = async () => {
    setState("checking");
    const result = await probe(draft);
    setState(result);
    if (result === "ok") {
      saveConnection(draft);
      onChange(loadConnection());
      setOpen(false);
    }
  };
  const reset = () => {
    saveConnection(null);
    onChange(null);
    setDaemonUrl("");
    setApiUrl("");
    setToken("");
    setState("idle");
  };

  return (
    <Card testId="fe2-commander-connection">
      <Stack gap={4}>
        <Stack direction="row" gap={3} align="center" wrap>
          <Icon name="info" aria-label="接続先" />
          <span style={{ fontSize: 13 }}>
            接続先: <strong>{saved ? "リモート（トンネル経由）" : "このPC（127.0.0.1）"}</strong>
          </span>
          <Badge tone={saved ? "info" : "neutral"} testId="fe2-commander-connection-mode">
            {saved ? new URL(saved.apiUrl).host : "ローカル"}
          </Badge>
          <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} testId="fe2-commander-connection-edit">
            {open ? "閉じる" : "接続先を設定"}
          </Button>
        </Stack>
        {saved ? null : (
          <span style={{ opacity: 0.8, fontSize: 13 }}>
            ローカル接続は Commander を起動している PC でしか使えません。スマホや別の PC から使うには、PC で
            トンネルを起動し（commander/README.md）、下の「接続先を設定」に URL とトークンを入れてください。
          </span>
        )}
        {open ? (
          <Stack gap={4} testId="fe2-commander-connection-form">
            <FormField label="daemon の URL" help="例: https://commander-daemon.developershub.jp" htmlFor="fe2-cmdr-daemon">
              <TextField id="fe2-cmdr-daemon" type="url" value={daemonUrl} onChange={setDaemonUrl} invalid={daemonBad} testId="fe2-cmdr-daemon" />
            </FormField>
            <FormField label="API（service）の URL" help="例: https://commander-api.developershub.jp" htmlFor="fe2-cmdr-api">
              <TextField id="fe2-cmdr-api" type="url" value={apiUrl} onChange={setApiUrl} invalid={apiBad} testId="fe2-cmdr-api" />
            </FormField>
            <FormField
              label="操作トークン"
              help="PC の commander/.commander.env.local にある COMMANDER_OPERATOR_TOKEN。この端末のブラウザにだけ保存されます"
              htmlFor="fe2-cmdr-token"
            >
              <TextField id="fe2-cmdr-token" type="password" value={token} onChange={setToken} testId="fe2-cmdr-token" />
            </FormField>
            {daemonBad || apiBad ? (
              <p role="alert" style={{ color: "var(--dub-color-fg-danger, #cf222e)", fontSize: 13, margin: 0 }}>
                URL は https（PC 自身なら http://127.0.0.1 も可）で入力してください。
              </p>
            ) : null}
            {state !== "idle" ? (
              <span role="status" data-testid="fe2-commander-connection-status" style={{ fontSize: 13 }}>
                {PROBE_LABEL[state]}
              </span>
            ) : null}
            <Stack direction="row" gap={3}>
              <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={state === "checking"} testId="fe2-commander-connection-save">
                接続して保存
              </Button>
              {saved ? (
                <Button variant="secondary" onClick={reset} testId="fe2-commander-connection-reset">
                  このPC（127.0.0.1）に戻す
                </Button>
              ) : null}
            </Stack>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

export function CommanderScreen(): JSX.Element {
  const [conn, setConn] = useState<CommanderConnection | null>(() => loadConnection());
  // Bumped on every save/reset so the workspace remounts and every stream/poll restarts
  // against the new endpoints (a token-only change included).
  const [rev, setRev] = useState(0);
  const clients = useMemo(() => clientsFor(conn), [conn]);
  const change = (c: CommanderConnection | null) => {
    setConn(c);
    setRev((r) => r + 1);
  };

  return (
    <Stack gap={5} testId="fe2-commander">
      <PageHeader title="Commander" />
      <ConnectionCard saved={conn} onChange={change} />
      <div data-testid="fe2-commander-workspace">
        <CommanderWorkspace key={rev} {...clients} />
      </div>
    </Stack>
  );
}
