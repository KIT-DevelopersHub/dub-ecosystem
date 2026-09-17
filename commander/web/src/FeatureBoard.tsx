import { useCallback, useEffect, useState } from "react";
import {
  HttpCommanderApi,
  PHASE_LABELS,
  type ApiError,
  type CommanderApi,
  type Feature,
  type FeatureDetail,
  type FeaturePhase,
} from "./lib/commanderApi.ts";
import { StatusBoard } from "./StatusBoard.tsx";

interface FeatureBoardProps {
  api?: CommanderApi;
}

const defaultApi = new HttpCommanderApi();

function errorMessage(e: ApiError): string {
  switch (e.error) {
    case "illegal_transition":
      return `段飛ばし禁止: この遷移は許可されていません (${e.status})`;
    case "approval_required":
      return `自己承認禁止: ユーザーの明示承認が必要です (${e.status})`;
    default:
      return `${e.error}${e.message ? `: ${e.message}` : ""} (${e.status})`;
  }
}

function PhaseBadge({ phase }: { phase: FeaturePhase }) {
  return (
    <span
      data-testid="phase-badge"
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid var(--color-border, #2a2f3a)",
        background: "var(--color-surface, #1a1e27)",
      }}
    >
      {PHASE_LABELS[phase]}
    </span>
  );
}

export function FeatureBoard({ api = defaultApi }: FeatureBoardProps) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingApproval, setPendingApproval] = useState<FeaturePhase | null>(null);
  const [title, setTitle] = useState("");
  const [ledgerRef, setLedgerRef] = useState("");

  const refresh = useCallback(async () => {
    // Resilient: if the worker/daemon is down, show an empty board rather than throw.
    try {
      setFeatures(await api.listFeatures());
    } catch {
      setFeatures([]);
    }
  }, [api]);

  const openFeature = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setError(null);
      setPendingApproval(null);
      setDetail(await api.getFeature(id));
    },
    [api],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    if (title.trim() === "") return;
    const res = await api.createFeature({
      title: title.trim(),
      ledgerRef: ledgerRef.trim() || undefined,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setTitle("");
    setLedgerRef("");
    await refresh();
    await openFeature(res.value.id);
  }, [api, title, ledgerRef, refresh, openFeature]);

  const performTransition = useCallback(
    async (to: FeaturePhase, approvedByUser: boolean) => {
      if (!selectedId) return;
      setError(null);
      const res = await api.transition(selectedId, to, { approvedByUser });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPendingApproval(null);
      await refresh();
      await openFeature(selectedId);
    },
    [api, selectedId, refresh, openFeature],
  );

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>フィーチャー フェーズ管理</h2>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>
        1 機能 = 1 エントリ。demo→staging→本番 のフェーズ遷移はサーバー側の状態機械で
        段飛ばし/自己承認を禁止。承認必須の遷移は明示承認が要る。
      </p>

      {/* create */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input
          aria-label="new-feature-title"
          placeholder="機能名"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inputStyle}
        />
        <input
          aria-label="new-feature-ledger"
          placeholder="台帳参照 (任意)"
          value={ledgerRef}
          onChange={(e) => setLedgerRef(e.target.value)}
          style={inputStyle}
        />
        <button type="button" onClick={create} disabled={title.trim() === ""} style={btnStyle}>
          機能を追加
        </button>
      </div>

      <StatusBoard features={features} onSelect={openFeature} selectedId={selectedId} />

      {error && (
        <div
          data-testid="error-banner"
          role="alert"
          style={{
            marginBottom: 16,
            padding: 10,
            borderRadius: 8,
            border: "1px solid #f87171",
            background: "rgba(248,113,113,0.12)",
            color: "#fca5a5",
            fontSize: 13,
          }}
        >
          {errorMessage(error)}
        </div>
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* list */}
        <ul data-testid="feature-list" style={{ listStyle: "none", padding: 0, margin: 0, minWidth: 260 }}>
          {features.length === 0 && (
            <li style={{ opacity: 0.6, fontSize: 13 }}>まだ機能がありません</li>
          )}
          {features.map((f) => (
            <li key={f.id} style={{ marginBottom: 6 }}>
              <button
                type="button"
                onClick={() => openFeature(f.id)}
                aria-pressed={f.id === selectedId}
                style={{
                  ...rowStyle,
                  outline: f.id === selectedId ? "2px solid var(--color-primary, #3b82f6)" : "none",
                }}
              >
                <span style={{ fontWeight: 600 }}>{f.title}</span>
                <PhaseBadge phase={f.phase} />
              </button>
            </li>
          ))}
        </ul>

        {/* detail */}
        {detail && (
          <div data-testid="feature-detail" style={{ flex: 1, minWidth: 320 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
              <strong>{detail.feature.title}</strong>
              <PhaseBadge phase={detail.feature.phase} />
            </div>

            <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.8 }}>次に進めるフェーズ:</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {detail.allowedTransitions.length === 0 && (
                <span style={{ fontSize: 13, opacity: 0.6 }}>終端（これ以上進めません）</span>
              )}
              {detail.allowedTransitions.map((t) => (
                <button
                  key={t.to}
                  type="button"
                  data-testid={`transition-${t.to}`}
                  onClick={() =>
                    t.requiresApproval
                      ? setPendingApproval(t.to)
                      : performTransition(t.to, false)
                  }
                  style={{
                    ...btnStyle,
                    background: t.requiresApproval
                      ? "var(--color-warning, #b45309)"
                      : "var(--color-primary, #3b82f6)",
                  }}
                >
                  {t.label}
                  {t.requiresApproval && (
                    <span data-testid={`approval-flag-${t.to}`} title="承認必須" style={{ marginLeft: 6 }}>
                      🔒要承認
                    </span>
                  )}
                </button>
              ))}
            </div>

            {pendingApproval && (
              <div
                data-testid="approval-confirm"
                style={{
                  marginTop: 12,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--color-warning, #b45309)",
                  fontSize: 13,
                }}
              >
                <div style={{ marginBottom: 8 }}>
                  ⚠ 「{PHASE_LABELS[pendingApproval]}」への遷移は<strong>ユーザー承認が必須</strong>です。
                  自己承認は禁止されています。承認して進めますか？
                </div>
                <button
                  type="button"
                  data-testid="approve-and-run"
                  onClick={() => performTransition(pendingApproval, true)}
                  style={btnStyle}
                >
                  承認して実行
                </button>
                <button
                  type="button"
                  onClick={() => setPendingApproval(null)}
                  style={{ ...btnStyle, marginLeft: 8, background: "transparent", border: "1px solid var(--color-border, #2a2f3a)" }}
                >
                  キャンセル
                </button>
              </div>
            )}

            <div style={{ marginTop: 20, fontSize: 13, opacity: 0.8 }}>遷移履歴（監査ログ）:</div>
            <ol data-testid="transition-history" style={{ fontSize: 13, paddingLeft: 18 }}>
              {detail.transitions.map((tx) => (
                <li key={tx.id}>
                  {PHASE_LABELS[tx.fromPhase]} → {PHASE_LABELS[tx.toPhase]}{" "}
                  <span style={{ opacity: 0.7 }}>
                    [{tx.actor}
                    {tx.approvedByUser ? " / 承認あり" : ""}]
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--color-border, #2a2f3a)",
  background: "var(--color-surface, #1a1e27)",
  color: "inherit",
  font: "inherit",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: 0,
  background: "var(--color-primary, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--color-border, #2a2f3a)",
  background: "var(--color-surface, #1a1e27)",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
};
