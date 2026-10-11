import { useState } from "react";
import { HttpCommanderClient } from "./lib/client.ts";
import { btnGhost, btnPrimary, t } from "./lib/theme.ts";

export interface RestartClient {
  bootId(): Promise<string | null>;
  restart(): Promise<{ from: string; to: string }>;
}

interface Props {
  client?: RestartClient;
  /** Called once the new stack answers. Default: reload the page. */
  onRestarted?: () => void;
  pollMs?: number;
  timeoutMs?: number;
}

type State =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "updating" }
  | { kind: "restarting"; from: string; to: string }
  | { kind: "error"; message: string };

const defaultClient = new HttpCommanderClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the web dev server serves this page again (it restarts with the daemon). */
async function webIsUp(): Promise<boolean> {
  try {
    return (await fetch(window.location.href, { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}

/** "更新して再起動": pull the latest main and restart the local Commander stack. */
export function RestartButton({
  client = defaultClient,
  onRestarted = () => window.location.reload(),
  pollMs = 2000,
  timeoutMs = 180_000,
}: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const run = async () => {
    setState({ kind: "updating" });
    const before = await client.bootId();
    let result: { from: string; to: string };
    try {
      result = await client.restart();
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
      return;
    }
    setState({ kind: "restarting", ...result });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const now = await client.bootId();
      if (now && now !== before && (await webIsUp())) {
        onRestarted();
        return;
      }
    }
    setState({
      kind: "error",
      message: "再起動を確認できませんでした。commander/.dev/logs/restart.log を確認してください",
    });
  };

  const note = (text: string, color: string = t.textMuted) => (
    <span data-testid="restart-status" style={{ fontSize: 13, color }}>
      {text}
    </span>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: t.space3 }}>
      {state.kind === "confirm" && (
        <>
          {note("最新の main に更新して Commander を再起動します（実行中のタスクがある時は再起動しません）")}
          <button type="button" data-testid="restart-confirm" onClick={run} style={btnPrimary}>
            再起動する
          </button>
          <button type="button" onClick={() => setState({ kind: "idle" })} style={btnGhost}>
            やめる
          </button>
        </>
      )}
      {state.kind === "updating" && note("最新の main を取得中…")}
      {state.kind === "restarting" &&
        note(
          `${state.from === state.to ? "すでに最新です" : `${state.from} → ${state.to} に更新しました`}。` +
            "再起動中… 立ち上がったら自動で再読み込みします",
        )}
      {state.kind === "error" && note(state.message, t.danger)}
      {(state.kind === "idle" || state.kind === "error") && (
        <button
          type="button"
          data-testid="restart-open"
          onClick={() => setState({ kind: "confirm" })}
          style={btnGhost}
        >
          更新して再起動
        </button>
      )}
    </div>
  );
}
