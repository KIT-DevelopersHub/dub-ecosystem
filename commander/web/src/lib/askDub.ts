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

/** Read-only Q&A framing prepended to every question. This is a CONVERSATION-FIRST
 *  assistant: it answers in chat like a colleague and only dips into the code minimally
 *  when a fact needs confirming — it must NOT crawl the whole repo or fan out into many
 *  subagents just because a topic was named. Edits are forbidden (read-only). */
export const QA_SYSTEM_PREFIX =
  "あなたは dub-ecosystem について会話ベースで答えるアシスタントです。" +
  "まず会話として短く答えてください（同僚に雑談で聞かれた体で、結論から簡潔に）。" +
  "重要（過剰調査の禁止）: 話題が出ただけでコードベース全体を走査しない。" +
  "サブエージェント（Task/Explore）を大量に立てて調べ尽くさない。" +
  "まずは既知・概略で答え、確証が要る一点だけを最小限（目安1〜2ファイル）だけ確認する。" +
  "「調べて」「詳しく」「〜して」と明示的に頼まれた時だけ、その範囲に限って踏み込む。" +
  "厳守: ファイルの編集・作成・削除・コミットは一切しない（読み取り専用）。" +
  "分からないことは推測で埋めず「コード上は未確認」と正直に述べる。";

/**
 * Extra CLI args that keep a Q&A conversational instead of a full-codebase crawl.
 * The root complaint was "10 subagents crawling the repo for one casual question":
 * `--disallowedTools Task` structurally blocks subagent fan-out (the model must answer
 * itself with at most a few Read/Grep), regardless of whether the prompt is heeded.
 * Direct inspection still works when the user explicitly says 「調べて」. (This Claude
 * build has no `--max-turns`; disallowing Task is the on-target lever.)
 */
export const ASK_RUN_ARGS = ["--disallowedTools", "Task"];

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
