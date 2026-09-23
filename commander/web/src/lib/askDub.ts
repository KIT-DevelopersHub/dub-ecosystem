// "Dubに聞く" — Q&A chat helpers. This feature reuses the SAME exec bridge the board
// uses (daemon POST /runs + SSE), but points the spawned claude at the dub-ecosystem
// repo with a READ-ONLY Q&A prompt: the operator asks "◯◯はどうなってる?" and claude
// answers by inspecting the real code. No daemon change is needed — a Q&A run is just a
// run with cwd=dub-ecosystem and a question-answering prompt (no taskId, so it never
// shows on the task board).

import type { DaemonRunEvent } from "./client.ts";

/** Where the Q&A runs. Override with VITE_DUB_ECOSYSTEM_PATH for a different checkout. */
export const DUB_ECOSYSTEM_CWD =
  (import.meta.env?.VITE_DUB_ECOSYSTEM_PATH as string | undefined) ??
  "/Users/kota/dev/dub-ecosystem";

/** Read-only Q&A framing prepended to every question. Explicitly forbids edits so the
 *  spawned claude (even under acceptEdits) treats this as an inspection task. */
export const QA_SYSTEM_PREFIX =
  "あなたは dub-ecosystem コードベースの Q&A アシスタントです。" +
  "ユーザーの質問に、このリポジトリの実際のコードを調べて日本語で答えてください。" +
  "厳守: ファイルの編集・作成・削除・コミットは一切しない（読み取り専用の調査のみ）。" +
  "回答は PREP（結論→理由→根拠）で簡潔に。関連するファイルパスを添える。" +
  "分からないことは推測で埋めず「コード上は確認できない」と正直に述べる。";

/**
 * Compose the prompt for a Q&A run. Prior Q&A turns are re-injected as context so a
 * follow-up question keeps the thread (P0: new spawn + re-injection; P1 = --resume).
 */
export function buildAskPrompt(question: string, priorTranscript = ""): string {
  const ctx = priorTranscript.trim()
    ? `\n\n---\nこれまでの会話（文脈）:\n${priorTranscript.trim()}\n---`
    : "";
  return `${QA_SYSTEM_PREFIX}${ctx}\n\n質問: ${question.trim()}`;
}

/** Build the re-injection transcript from prior chat turns (bounded to the last few). */
export function buildTranscript(
  turns: { role: "user" | "assistant"; text: string }[],
  maxTurns = 6,
): string {
  return turns
    .filter((t) => t.text.trim())
    .slice(-maxTurns)
    .map((t) => `${t.role === "user" ? "Q" : "A"}: ${t.text.trim()}`)
    .join("\n\n");
}

/** A single piece of information decoded from one claude stream-json event. */
export type ClaudeDelta =
  | { kind: "text"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "result"; text: string };

interface ToolUse {
  name?: string;
  input?: Record<string, unknown>;
}

/** Short human label for a tool_use block, e.g. `Read src/App.tsx` / `Grep "calendar"`. */
function describeTool(tool: ToolUse): string {
  const name = tool.name ?? "tool";
  const input = tool.input ?? {};
  const pick = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const target =
    pick("file_path") ??
    pick("path") ??
    pick("pattern") ??
    pick("query") ??
    pick("command") ??
    pick("description");
  if (!target) return name;
  const trimmed = target.length > 80 ? `${target.slice(0, 80)}…` : target;
  return `${name} ${trimmed}`;
}

/**
 * Decode one DaemonRunEvent into zero or more deltas the chat UI can fold in:
 *  - assistant text blocks  -> { kind: "text" }   (accumulate into the bubble)
 *  - assistant tool_use     -> { kind: "tool" }   (show as an activity line)
 *  - the terminal result    -> { kind: "result" } (authoritative final answer)
 * stderr/error surface as text so failures are visible in the bubble.
 */
export function parseClaudeEvent(ev: DaemonRunEvent): ClaudeDelta[] {
  if (ev.type === "stderr") {
    return ev.line && ev.line.trim() ? [{ kind: "tool", label: `stderr: ${ev.line.trim()}` }] : [];
  }
  if (ev.type === "error") {
    return ev.message ? [{ kind: "text", text: `\n[エラー] ${ev.message}` }] : [];
  }
  if (ev.type !== "claude") return [];

  const data = ev.data as
    | {
        type?: string;
        subtype?: string;
        result?: unknown;
        message?: { content?: unknown };
      }
    | undefined;
  if (!data) return [];

  // Terminal result object = the complete final answer.
  if (data.type === "result" && typeof data.result === "string") {
    return [{ kind: "result", text: data.result }];
  }

  // Assistant message: text blocks + tool_use blocks.
  if (data.type === "assistant" && data.message && Array.isArray(data.message.content)) {
    const out: ClaudeDelta[] = [];
    for (const block of data.message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        out.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({ kind: "tool", label: describeTool(block as ToolUse) });
      }
    }
    return out;
  }
  return [];
}
