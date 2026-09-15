// Client for the commander-service phase-gate API. In local/dev the operator runs the
// worker (wrangler dev, default :8787); the base is overridable via VITE_COMMANDER_API.
// The phase gate itself is enforced server-side (@dub/commander-phases): this client
// only renders the allowed edges the API returns and surfaces its 409/403 errors.

export type FeaturePhase =
  | "demo_building"
  | "demo_review"
  | "demo_rejected"
  | "staging_deployed"
  | "staging_review"
  | "staging_rejected"
  | "prod_shipped";

export interface Feature {
  id: string;
  title: string;
  phase: FeaturePhase;
  ledgerRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionSpec {
  to: FeaturePhase;
  requiresApproval: boolean;
  label: string;
}

export interface PhaseTransition {
  id: string;
  featureId: string;
  fromPhase: FeaturePhase;
  toPhase: FeaturePhase;
  approvedByUser: boolean;
  actor: "user" | "system";
  note: string | null;
  createdAt: string;
}

export interface FeatureDetail {
  feature: Feature;
  allowedTransitions: TransitionSpec[];
  transitions: PhaseTransition[];
}

export type ApiError = {
  status: number;
  error: string;
  message?: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface CommanderApi {
  listFeatures(): Promise<Feature[]>;
  createFeature(input: { title: string; ledgerRef?: string }): Promise<Result<Feature>>;
  getFeature(id: string): Promise<FeatureDetail>;
  transition(
    id: string,
    to: FeaturePhase,
    opts?: { approvedByUser?: boolean; note?: string },
  ): Promise<Result<{ feature: Feature; transition: PhaseTransition }>>;
}

const DEFAULT_BASE =
  (import.meta.env?.VITE_COMMANDER_API as string | undefined) ?? "http://127.0.0.1:8787";

/** Human label for a phase, for badges. */
export const PHASE_LABELS: Record<FeaturePhase, string> = {
  demo_building: "demo実装中",
  demo_review: "demo確認待ち",
  demo_rejected: "demo却下(要修正)",
  staging_deployed: "staging反映済",
  staging_review: "staging確認待ち",
  staging_rejected: "staging却下(要修正)",
  prod_shipped: "本番反映済",
};

export class HttpCommanderApi implements CommanderApi {
  constructor(
    private baseUrl: string = DEFAULT_BASE,
    private token?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h["x-commander-token"] = this.token;
    return h;
  }

  async listFeatures(): Promise<Feature[]> {
    const res = await fetch(`${this.baseUrl}/features`);
    if (!res.ok) throw new Error(`GET /features -> ${res.status}`);
    return ((await res.json()) as { features: Feature[] }).features;
  }

  async createFeature(input: { title: string; ledgerRef?: string }): Promise<Result<Feature>> {
    const res = await fetch(`${this.baseUrl}/features`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: { status: res.status, error: String(body.error ?? "error") } };
    }
    return { ok: true, value: body.feature as Feature };
  }

  async getFeature(id: string): Promise<FeatureDetail> {
    const res = await fetch(`${this.baseUrl}/features/${id}`);
    if (!res.ok) throw new Error(`GET /features/${id} -> ${res.status}`);
    return (await res.json()) as FeatureDetail;
  }

  async transition(
    id: string,
    to: FeaturePhase,
    opts: { approvedByUser?: boolean; note?: string } = {},
  ): Promise<Result<{ feature: Feature; transition: PhaseTransition }>> {
    const res = await fetch(`${this.baseUrl}/features/${id}/transition`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ to, ...opts }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: {
          status: res.status,
          error: String(body.error ?? "error"),
          message: typeof body.message === "string" ? body.message : undefined,
        },
      };
    }
    return {
      ok: true,
      value: {
        feature: body.feature as Feature,
        transition: body.transition as PhaseTransition,
      },
    };
  }
}
