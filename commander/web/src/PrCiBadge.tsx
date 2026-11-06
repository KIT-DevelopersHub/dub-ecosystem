// PR CI status + 「確認」 in the task detail (drawer) — never on the board list: compact
// pass count, expandable per-check list with links, a refresh (bypasses the 45s cache),
// and the button that adds the 確認した production-gate label (confirm dialog,
// optimistic 「確認済み」 with rollback). Eligibility is decided by commander-service; the
// button only mirrors it and shows the reason when it cannot be pressed.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, Skeleton } from "@dub/ui";
import {
  badgeOf,
  blockerText,
  CHECK_ICON,
  CHECK_LABEL,
  parsePrRef,
  type PrChecksApi,
  type PrChecksView,
} from "./lib/prChecks.ts";
import { t } from "./lib/theme.ts";

interface Props {
  prUrl: string;
  api: PrChecksApi;
  /** Refresh interval while settled; a running CI refreshes faster. */
  pollMs?: number;
}

const STATE_COLOR = { pass: t.success, fail: t.danger, pending: t.textMuted, skipped: t.textMuted } as const;

export function PrCiBadge({ prUrl, api, pollMs = 60_000 }: Props) {
  const ref = parsePrRef(prUrl);
  const [view, setView] = useState<PrChecksView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (fresh = false) => {
      if (!ref) return;
      const r = await api.getChecks(ref, { fresh });
      if (r.ok) {
        setView(r.value);
        setLoadError(null);
      } else {
        setLoadError(r.error.message ?? blockerText(r.error.error));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, ref?.repo, ref?.number],
  );

  // Esc while the confirm dialog is open closes ONLY the dialog: the drawer behind it also
  // closes on a document-level Esc, so take it first (capture) and stop it there.
  useEffect(() => {
    if (!asking) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setAsking(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [asking]);

  const pending = view?.pr.summary.state === "pending";
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => void load(), pending ? Math.min(pollMs, 20_000) : pollMs);
    return () => clearInterval(id);
  }, [load, pending, pollMs]);

  if (!ref) return null;
  const testId = `pr-ci-${ref.number}`;

  if (!view) {
    return (
      <div data-testid={testId} style={{ marginTop: t.space2 }} onClick={(e) => e.stopPropagation()}>
        {loadError ? (
          <span title={loadError} data-testid={`${testId}-error`} style={{ fontSize: 11, color: t.textMuted }}>
            CI: {loadError}
          </span>
        ) : (
          <Skeleton width={96} height={18} />
        )}
      </div>
    );
  }

  const { pr, confirm } = view;
  const badge = badgeOf(pr.summary);

  const doConfirm = async () => {
    setAsking(false);
    setActionError(null);
    setBusy(true);
    const before = view;
    // Optimistic: show 確認済み immediately; roll back if GitHub/the service refuses.
    setView({ ...view, pr: { ...pr, confirmed: true, labels: [...pr.labels, "確認した"] } });
    const r = await api.confirm(ref, pr.headSha);
    setBusy(false);
    if (r.ok) {
      setView({ pr: r.value.pr, confirm: r.value.confirm });
    } else {
      setView(before);
      setActionError(r.error.message ?? blockerText(r.error.error));
      void load(true);
    }
  };

  return (
    // Clicks from the dialog portal bubble through the React tree; keep them from reaching
    // the drawer's scrim/handlers.
    <div
      data-testid={testId}
      data-ci-state={pr.summary.state}
      onClick={(e) => e.stopPropagation()}
      style={{ marginTop: t.space2 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: t.space2 }}>
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
          title={`PR #${pr.number} の CI 状況（クリックで内訳）`}
          onClick={() => setOpen((v) => !v)}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
        >
          <Badge tone={badge.tone} testId={`${testId}-badge`}>
            CI {badge.text}
          </Badge>
        </button>
        <button
          type="button"
          data-testid={`${testId}-refresh`}
          title="GitHub から最新を取得（キャッシュを使わない）"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await load(true);
            setRefreshing(false);
          }}
          style={{
            background: "transparent",
            border: `1px solid ${t.border}`,
            borderRadius: "var(--dub-radius-sm, 8px)",
            padding: `0 ${t.space2}`,
            font: "inherit",
            fontSize: 11,
            lineHeight: "18px",
            color: t.textMuted,
            cursor: "pointer",
          }}
        >
          {refreshing ? "更新中…" : "↻ 更新"}
        </button>
        {pr.staging.stagingへ && <Badge tone="info">stagingへ</Badge>}
        {pr.staging.staging2へ && <Badge tone="info">staging2へ</Badge>}
        <span style={{ marginLeft: "auto" }}>
          {pr.confirmed ? (
            <Badge tone="success" testId={`${testId}-confirmed`}>
              ✓ 確認済み
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="primary"
              testId={`${testId}-confirm`}
              disabled={!confirm.allowed || busy}
              loading={busy}
              onClick={() => setAsking(true)}
            >
              確認
            </Button>
          )}
        </span>
      </div>

      {!pr.confirmed && !confirm.allowed && confirm.reason && (
        <div data-testid={`${testId}-reason`} style={{ marginTop: t.space1, fontSize: 11, color: t.textMuted }}>
          {blockerText(confirm.reason)}
        </div>
      )}
      {actionError && (
        <div data-testid={`${testId}-action-error`} role="alert" style={{ marginTop: t.space1, fontSize: 11, color: t.danger }}>
          確認できませんでした: {actionError}
        </div>
      )}

      {open && (
        <ul
          data-testid={`${testId}-list`}
          style={{
            listStyle: "none",
            margin: `${t.space2} 0 0`,
            padding: t.space2,
            background: t.sunken,
            border: `1px solid ${t.border}`,
            borderRadius: "var(--dub-radius-sm, 8px)",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: t.space1,
            fontSize: 12,
            boxSizing: "border-box",
            width: "100%",
            minWidth: 0,
          }}
        >
          {pr.checks.length === 0 && <li style={{ color: t.textMuted }}>チェックはまだ報告されていません</li>}
          {pr.checks.map((c) => (
            <li key={`${c.name}-${c.url ?? ""}`} data-check-state={c.state} style={{ display: "flex", gap: t.space2, alignItems: "baseline" }}>
              <span aria-hidden style={{ color: STATE_COLOR[c.state], width: 12, flexShrink: 0 }}>
                {CHECK_ICON[c.state]}
              </span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" style={{ color: t.text }}>
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}
                {c.required && <span style={{ color: t.textMuted }}> · 必須</span>}
                {c.labelGate && c.state !== "pass" && <span style={{ color: t.textMuted }}> · 確認したラベル待ち</span>}
              </span>
              <span style={{ color: STATE_COLOR[c.state], whiteSpace: "nowrap" }}>{CHECK_LABEL[c.state]}</span>
            </li>
          ))}
          <li style={{ color: t.textMuted, marginTop: t.space1, overflowWrap: "anywhere" }}>
            <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: t.textMuted }}>
              PR #{pr.number}
            </a>
            {pr.mergeStateStatus ? ` · merge: ${pr.mergeStateStatus}` : ""} · head {pr.headSha.slice(0, 7)}
          </li>
        </ul>
      )}

      <ConfirmDialog
        open={asking}
        danger
        title="本番への承認（確認した）"
        confirmLabel="確認したを付ける"
        testId={`${testId}-dialog`}
        message={
          <div style={{ display: "grid", gap: t.space2, fontSize: 13 }}>
            <div>
              PR #{pr.number}「{pr.title}」に <strong>確認した</strong> ラベルを付けます。付けるとこの PR は
              main へマージでき、本番にデプロイされます。
            </div>
            <div style={{ color: t.textMuted }}>
              対象 commit: {pr.headSha.slice(0, 7)} ・ CI {badge.text}
            </div>
            {confirm.warnings.map((w) => (
              <div key={w} style={{ color: t.warning }}>
                ⚠ {w}
              </div>
            ))}
          </div>
        }
        onConfirm={doConfirm}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}
