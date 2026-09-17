// Status board: every feature grouped into the 4 lifecycle stages so "今どの段階か"
// is visible at a glance across ALL features. Pure view over the same Feature[] the
// FeatureBoard already loads (no new API): it maps the 7 FSM phases -> 4 columns.
import {
  PHASE_LABELS,
  type Feature,
  type FeaturePhase,
} from "./lib/commanderApi.ts";

export interface Stage {
  key: string;
  label: string;
  phases: FeaturePhase[];
}

// 実装中(要修正含む) / demo確認中 / staging / 本番。Rejected phases need rework, so they
// sit in 実装中; the exact phase is still shown as a per-chip badge.
export const STAGES: readonly Stage[] = [
  { key: "building", label: "実装中", phases: ["demo_building", "demo_rejected", "staging_rejected"] },
  { key: "demo", label: "demo確認中", phases: ["demo_review"] },
  { key: "staging", label: "staging", phases: ["staging_deployed", "staging_review"] },
  { key: "prod", label: "本番", phases: ["prod_shipped"] },
];

export function stageOf(phase: FeaturePhase): Stage {
  return STAGES.find((s) => s.phases.includes(phase)) ?? STAGES[0]!;
}

interface StatusBoardProps {
  features: Feature[];
  onSelect?: (id: string) => void;
  selectedId?: string | null;
}

export function StatusBoard({ features, onSelect, selectedId }: StatusBoardProps) {
  const byStage = new Map<string, Feature[]>(STAGES.map((s) => [s.key, []]));
  for (const f of features) byStage.get(stageOf(f.phase).key)!.push(f);

  return (
    <section style={{ marginTop: 24 }} data-testid="status-board">
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>ステータスボード</h2>
      <p style={{ opacity: 0.7, marginTop: 0, fontSize: 13 }}>
        各機能が今どの段階か（実装中 → demo確認 → staging → 本番）を一覧表示。
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${STAGES.length}, minmax(160px, 1fr))`,
          gap: 12,
          overflowX: "auto",
        }}
      >
        {STAGES.map((stage) => {
          const items = byStage.get(stage.key)!;
          return (
            <div
              key={stage.key}
              data-testid={`stage-${stage.key}`}
              style={{
                border: "1px solid var(--color-border, #2a2f3a)",
                borderRadius: 10,
                background: "var(--color-surface, #12151c)",
                padding: 10,
                minWidth: 160,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 13 }}>{stage.label}</strong>
                <span
                  data-testid={`stage-count-${stage.key}`}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    minWidth: 20,
                    textAlign: "center",
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: "var(--color-bg, #0f1115)",
                    border: "1px solid var(--color-border, #2a2f3a)",
                  }}
                >
                  {items.length}
                </span>
              </div>

              {items.length === 0 && (
                <div style={{ opacity: 0.5, fontSize: 12 }}>—</div>
              )}

              {items.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`stage-card-${f.id}`}
                  onClick={() => onSelect?.(f.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    marginBottom: 6,
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: "1px solid var(--color-border, #2a2f3a)",
                    background: "var(--color-surface, #1a1e27)",
                    color: "inherit",
                    cursor: onSelect ? "pointer" : "default",
                    outline:
                      f.id === selectedId ? "2px solid var(--color-primary, #3b82f6)" : "none",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</div>
                  <div style={{ opacity: 0.7, fontSize: 11, marginTop: 2 }}>
                    {PHASE_LABELS[f.phase]}
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
