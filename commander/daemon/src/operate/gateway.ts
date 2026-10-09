// HTTP client for the Dub api-gateway, acting as the dedicated commander bot user.
//
// Auth: a session for the bot (its own user + a role holding only the catalog's keys —
// never the owner's). Either a pre-issued bearer token, or email/password which is
// exchanged at POST /auth/password/login and re-exchanged once on a 401 (sessions rotate
// and expire after an hour). Credentials live only in the daemon's env and are never
// logged, returned to the browser, or forwarded to a spawned claude.

import { API_PREFIX } from "./catalog.ts";

export interface GatewayConfig {
  baseUrl: string;
  token?: string;
  email?: string;
  password?: string;
}

export interface GatewayResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

export interface GatewayRequest {
  method: string;
  /** Path under API_PREFIX, already resolved (no :params). */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export type Fetch = typeof fetch;

/** "staging" | "本番" | "ローカル" — shown on the approval screen. */
export function environmentLabel(baseUrl: string): string {
  if (/127\.0\.0\.1|localhost/.test(baseUrl)) return "ローカル";
  return /staging/.test(baseUrl) ? "staging" : "本番";
}

export class GatewayClient {
  private token: string | undefined;
  private readonly config: GatewayConfig;
  private readonly fetchImpl: Fetch;

  constructor(config: GatewayConfig, fetchImpl: Fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.token = config.token;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private canLogin(): boolean {
    return Boolean(this.config.email && this.config.password);
  }

  private async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.config.baseUrl}${API_PREFIX}/auth/password/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (!res.ok || typeof data?.token !== "string") {
      throw new Error(`ボットユーザーのログインに失敗しました（${res.status}）`);
    }
    this.token = data.token;
  }

  private async send(req: GatewayRequest): Promise<Response> {
    const qs = new URLSearchParams(req.query ?? {}).toString();
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (req.body !== undefined) headers["content-type"] = "application/json";
    return this.fetchImpl(`${this.config.baseUrl}${API_PREFIX}${req.path}${qs ? `?${qs}` : ""}`, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
  }

  async request(req: GatewayRequest): Promise<GatewayResponse> {
    if (!this.token && this.canLogin()) await this.login();
    let res = await this.send(req);
    if (res.status === 401 && this.canLogin()) {
      await this.login();
      res = await this.send(req);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: keep the text */
    }
    return { status: res.status, ok: res.ok, data };
  }
}

/** Japanese reason for a failed call (never the raw JSON). */
export function describeFailure(res: GatewayResponse): string {
  const code = (res.data as { error?: { code?: unknown } | string } | null)?.error;
  const detail = typeof code === "string" ? code : typeof code?.code === "string" ? code.code : "";
  const base =
    res.status === 400 ? "入力内容が受け付けられませんでした"
    : res.status === 401 ? "ボットユーザーの認証が切れています"
    : res.status === 403 ? "ボットユーザーにこの操作の権限がありません"
    : res.status === 404 ? "対象が見つかりませんでした"
    : res.status === 409 ? "競合しました（既に存在する、または他の人が先に更新しました）"
    : res.status === 0 ? "API に接続できませんでした"
    : res.status >= 500 ? "サーバー側でエラーが発生しました"
    : "想定外の応答でした";
  return `${base}（${res.status}${detail ? ` ${detail}` : ""}）`;
}
