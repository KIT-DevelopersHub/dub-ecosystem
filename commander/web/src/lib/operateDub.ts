// "Dubを操作する" — an MCP-style operate console over the REAL Dub backend, distinct
// from the read-only "Dubに聞く" Q&A. Here the operator states an intent in natural
// language ("AさんからEさんまで5人のサンプルデータを本番に入れて") and a two-phase flow
// turns it into concrete, reviewable operations:
//
//   1) PLAN  — a claude run (read-only, no Task fan-out) inspects the repo schema and
//              emits a JSON plan of Operations (d1_read / d1_write / api_call). It does
//              NOT touch prod.
//   2) EXECUTE — the UI renders each Operation with its EXACT command. Read ops run
//              freely; writes require an explicit confirm; destructive ops (delete/drop/
//              truncate) require a typed confirmation. Only on confirm does the daemon
//              spawn a run that executes that ONE command against prod.
//
// Everything runs through the SAME daemon exec bridge (the "tools" are claude's Bash
// running wrangler d1 / curl). D1 access is additive per [[dub-mcp-style-operation]].

/** Where operate runs execute (the real dub-ecosystem checkout; wrangler resolves here). */
export const DUB_OPERATE_CWD =
  (import.meta.env?.VITE_DUB_ECOSYSTEM_PATH as string | undefined) ??
  "/Users/kota/dev/dub-ecosystem";

/** Cloudflare / D1 targets (overridable via env; defaults are the Dub prod values). */
export const CF_ACCOUNT_ID =
  (import.meta.env?.VITE_DUB_CF_ACCOUNT_ID as string | undefined) ??
  "b8f6ddbf8fa8cf4e421eae870bdb6dac";
export const D1_DB_NAME =
  (import.meta.env?.VITE_DUB_D1_NAME as string | undefined) ?? "dub-core";
export const D1_DB_ID =
  (import.meta.env?.VITE_DUB_D1_ID as string | undefined) ??
  "d663f9c6-499f-4c67-910d-e08733d5278d";
/** wrangler resolved from the pnpm store, relative to DUB_OPERATE_CWD. */
export const WRANGLER_BIN =
  (import.meta.env?.VITE_DUB_WRANGLER_BIN as string | undefined) ??
  "node_modules/.pnpm/node_modules/.bin/wrangler";

/** Block subagent fan-out on operate runs too (plan + execute stay lean & deterministic). */
export const OPERATE_RUN_ARGS = ["--disallowedTools", "Task"];

export type OperationKind = "d1_read" | "d1_write" | "api_call";

/** One reviewable operation in a plan. */
export interface Operation {
  id: string;
  kind: OperationKind;
  /** One-line human summary (何をするか). */
  title: string;
  /** SQL for d1_read / d1_write. */
  sql?: string;
  /** HTTP method / url / JSON body for api_call. */
  method?: string;
  url?: string;
  body?: string;
  /** True for delete/drop/truncate (and DELETE api calls) — needs a strong confirm. */
  destructive: boolean;
  /** Optional rationale from the planner. */
  note?: string;
}

export interface OperationPlan {
  summary?: string;
  ops: Operation[];
}

// --- classification safety net ---------------------------------------------------
// We NEVER trust the planner to under-classify a write as a read: the SQL/method is the
// source of truth. These re-derive kind + destructiveness from the operation itself.

const D1_READ_RE = /^\s*(select|pragma|explain|with[\s\S]*\bselect\b)/i;
const D1_DESTRUCTIVE_RE =
  /\b(delete\s+from|drop\s+(table|index|column|database|view|trigger)|truncate)\b/i;

/** SELECT/PRAGMA/EXPLAIN (incl. CTEs) are reads; anything else that writes is d1_write. */
export function classifyD1Sql(sql: string): "d1_read" | "d1_write" {
  return D1_READ_RE.test(sql) ? "d1_read" : "d1_write";
}

/** delete/drop/truncate = destructive (data loss), the strong-confirm tier. */
export function isDestructiveSql(sql: string): boolean {
  return D1_DESTRUCTIVE_RE.test(sql);
}

/** True when this op mutates prod state (needs at least an explicit confirm). */
export function isWrite(op: Operation): boolean {
  if (op.kind === "d1_read") return false;
  if (op.kind === "d1_write") return true;
  // api_call: GET/HEAD are reads; everything else mutates.
  return !/^(get|head|options)$/i.test(op.method ?? "GET");
}

/** Re-derive kind + destructive from the operation's own SQL/method (defense in depth). */
export function normalizeOperation(raw: Operation): Operation {
  const op = { ...raw };
  if ((op.kind === "d1_read" || op.kind === "d1_write") && op.sql) {
    op.kind = classifyD1Sql(op.sql);
    op.destructive = op.destructive || isDestructiveSql(op.sql);
  }
  if (op.kind === "api_call") {
    op.destructive = op.destructive || /^delete$/i.test(op.method ?? "");
  }
  return op;
}

// --- command building -------------------------------------------------------------

/** POSIX single-quote a value so it is passed to the shell verbatim (no expansion). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact wrangler command that runs this SQL against REMOTE (prod) D1. */
export function d1Command(sql: string): string {
  const readOnly = classifyD1Sql(sql) === "d1_read";
  // --json for reads (parseable rows); writes just report rows-affected.
  const jsonFlag = readOnly ? " --json" : "";
  return `${WRANGLER_BIN} d1 execute ${D1_DB_NAME} --remote${jsonFlag} --command ${shellQuote(sql)}`;
}

/** The exact curl command for an api_call op. */
export function apiCommand(op: Operation): string {
  const method = (op.method ?? "GET").toUpperCase();
  const parts = ["curl", "-sS", "-X", method, shellQuote(op.url ?? "")];
  if (op.body != null && op.body !== "") {
    parts.push("-H", shellQuote("content-type: application/json"), "-d", shellQuote(op.body));
  }
  return parts.join(" ");
}

/** The concrete shell command for any op (what the confirm gate shows and executes). */
export function commandFor(op: Operation): string {
  if (op.kind === "api_call") return apiCommand(op);
  return d1Command(op.sql ?? "");
}

// --- prompts ----------------------------------------------------------------------

/** Phase 1: turn an intent into a reviewable JSON plan WITHOUT touching prod. */
export const PLAN_SYSTEM_PROMPT =
  "あなたは Dub エコシステム(本番バックエンド)の操作プランナーです。" +
  "ユーザーの要望を、レビュー可能な具体的操作の一覧に落とし込みます。" +
  "厳守: この段階では本番に一切アクセスしない(SQL/APIを実行しない・書き込まない)。" +
  "スキーマ確認が要る場合のみ、リポジトリ内の infra/d1 のマイグレーション等を読み取りで参照する。" +
  "サブエージェントを立てない。" +
  "出力は必ず1つの ```json コードブロックだけにする(前後に説明文を書かない)。形式:" +
  ' {"summary": "全体の要約", "ops": [{"id":"op1","kind":"d1_read|d1_write|api_call",' +
  '"title":"何をするか(日本語1行)","sql":"...","method":"POST","url":"...","body":"...",' +
  '"destructive":false,"note":"補足"}]}。' +
  "SQL は additive を原則とし(スキーマ削除をしない)、実データに合う正確な列名で書く。" +
  "delete/drop/truncate を含む操作は destructive:true。d1_read=SELECT等の読み取り、" +
  "それ以外の書き込みは d1_write。api_call は Dub の HTTP API を叩く操作。" +
  `対象 D1: ${D1_DB_NAME} (id ${D1_DB_ID})。`;

/** Phase 3: execute EXACTLY one already-approved command and report its output. */
export function buildExecPrompt(command: string): string {
  return (
    "次のコマンドを1回だけそのまま実行し、出力(結果/エラー)をそのまま報告してください。" +
    "それ以外のことは一切しない: 追加のコマンド・ファイル編集・調査・確認を行わない。\n\n" +
    "```bash\n" +
    command +
    "\n```"
  );
}

// --- plan parsing -----------------------------------------------------------------

export type ParsePlanResult =
  | { ok: true; plan: OperationPlan }
  | { ok: false; error: string; raw: string };

/** Extract the LAST ```json fenced block (or a bare JSON object) from the planner text. */
export function extractJsonBlock(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = fence.exec(text)) !== null) {
    if (m[1] && m[1].trim()) last = m[1].trim();
  }
  if (last) return last;
  // Fallback: first {...} that spans an object.
  const brace = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (brace >= 0 && end > brace) return text.slice(brace, end + 1);
  return null;
}

/** Parse a planner answer into a normalized OperationPlan (kinds/destructive re-derived). */
export function parsePlan(text: string): ParsePlanResult {
  const block = extractJsonBlock(text);
  if (!block) return { ok: false, error: "プランJSONが見つかりませんでした", raw: text };
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (e) {
    return { ok: false, error: `プランJSONの解析に失敗: ${(e as Error).message}`, raw: block };
  }
  const obj = data as { summary?: unknown; ops?: unknown };
  if (!Array.isArray(obj.ops)) {
    return { ok: false, error: "プランに ops 配列がありません", raw: block };
  }
  const ops: Operation[] = obj.ops.map((rawOp, i) => {
    const o = (rawOp ?? {}) as Partial<Operation>;
    const kind: OperationKind =
      o.kind === "d1_write" || o.kind === "api_call" || o.kind === "d1_read"
        ? o.kind
        : "d1_read";
    return normalizeOperation({
      id: typeof o.id === "string" && o.id ? o.id : `op${i + 1}`,
      kind,
      title: typeof o.title === "string" ? o.title : "(無題の操作)",
      ...(typeof o.sql === "string" ? { sql: o.sql } : {}),
      ...(typeof o.method === "string" ? { method: o.method } : {}),
      ...(typeof o.url === "string" ? { url: o.url } : {}),
      ...(typeof o.body === "string" ? { body: o.body } : {}),
      destructive: o.destructive === true,
      ...(typeof o.note === "string" ? { note: o.note } : {}),
    });
  });
  return {
    ok: true,
    plan: { ...(typeof obj.summary === "string" ? { summary: obj.summary } : {}), ops },
  };
}
