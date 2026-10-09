// Client for the daemon's "Dubを操作" executor (/operate/*). The daemon holds the bot
// credentials and the allow-list; the browser only sends a plan, shows the preview, and
// asks for one execution of an approved preview.

export type OpKind = "read" | "write" | "delete";
export type OpRisk = "low" | "mid" | "high";

export interface CatalogEntry {
  id: string;
  area: "event" | "mail" | "notification";
  method: string;
  path: string;
  kind: OpKind;
  reversible: boolean;
  risk: OpRisk;
  description: string;
  /** Planner-only usage note. */
  hint?: string;
  impact: string;
  query?: string[];
  body?: { allowed: string[]; required: string[] };
  fieldLabels?: Record<string, string>;
}

export interface Catalog {
  configured: boolean;
  environment: string | null;
  entries: CatalogEntry[];
}

export interface PreviewCall {
  callId: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  params: Record<string, string>;
  target: string;
  before?: Record<string, unknown>;
}

export interface PreviewWrite {
  stepId: string;
  entryId: string;
  kind: OpKind;
  risk: OpRisk;
  reversible: boolean;
  description: string;
  impact: string;
  fieldLabels?: Record<string, string>;
  calls: PreviewCall[];
}

export interface ReadSummary {
  stepId: string;
  entryId: string;
  description: string;
  ok: boolean;
  count?: number;
  sample?: string;
  error?: string;
}

export interface Preview {
  previewId: string;
  summary: string;
  environment: string;
  reads: ReadSummary[];
  writes: PreviewWrite[];
  blockers: string[];
  expiresAt: string;
}

export type Verdict = "done" | "partial" | "failed";
export interface CallResult {
  callId: string;
  stepId: string;
  target: string;
  outcome: "ok" | "unverified" | "failed" | "skipped";
  message: string;
}
export interface ExecutionResult {
  previewId: string;
  verdict: Verdict;
  headline: string;
  results: CallResult[];
  executedAt: string;
}

/** A Japanese, user-presentable failure (never raw JSON). */
export class OperateError extends Error {
  constructor(
    message: string,
    readonly blockers: string[] = [],
  ) {
    super(message);
  }
}

export interface OperateClient {
  catalog(): Promise<Catalog>;
  preview(plan: unknown): Promise<Preview>;
  execute(previewId: string, skip: string[]): Promise<ExecutionResult>;
}

const DEFAULT_BASE =
  (import.meta.env?.VITE_COMMANDER_DAEMON as string | undefined) ?? "http://127.0.0.1:4319";
const DEFAULT_TOKEN = import.meta.env?.VITE_COMMANDER_TOKEN as string | undefined;

export class HttpOperateClient implements OperateClient {
  constructor(
    private baseUrl: string = DEFAULT_BASE,
    private token: string | undefined = DEFAULT_TOKEN,
  ) {}

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new OperateError("Commander の daemon に接続できませんでした（4319 が起動しているか確認してください）");
    }
    const data = (await res.json().catch(() => null)) as { error?: unknown; blockers?: unknown } | null;
    if (!res.ok) {
      const msg = typeof data?.error === "string" ? data.error : `daemon がエラーを返しました（${res.status}）`;
      const blockers = Array.isArray(data?.blockers) ? data.blockers.filter((b): b is string => typeof b === "string") : [];
      throw new OperateError(msg, blockers);
    }
    return data as T;
  }

  catalog(): Promise<Catalog> {
    return this.send("GET", "/operate/catalog");
  }

  preview(plan: unknown): Promise<Preview> {
    return this.send("POST", "/operate/preview", { plan });
  }

  execute(previewId: string, skip: string[]): Promise<ExecutionResult> {
    return this.send("POST", "/operate/execute", { previewId, skip });
  }
}
