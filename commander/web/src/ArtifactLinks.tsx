// Artifact URL links (P1-2) — the click-through the judgment loop closes on: 走らせる →
// URLが出る → クリックして確認. Auto-extracted from run output (service-side urls.ts) and
// stored on the task; here they render as links. Two variants:
//   - "card":   compact chips on a board card (never steal the card's open-click).
//   - "drawer": big, obvious "…を確認" buttons in the 成果物 tab.
//
// Phase-aware emphasis: whichever environment the task has *reached* is what the operator
// should look at now, so that URL is shown as the PRIMARY (big / filled) link and the
// others drop to secondary (small / collapsed). A staging-deployed task shows staging大,
// demo小; a demo-stage task shows demo大. 本番 reached → PR/本番参照を主に. Nothing is ever
// dropped — every captured URL stays reachable.
// When nothing is captured yet: a "URL待ち" skeleton while running, else a quiet empty note.
import type { CSSProperties } from "react";
import { t } from "./lib/theme.ts";
import type { FeaturePhase } from "./lib/commanderApi.ts";
import { DUB_STAGING_URL } from "./lib/reflection.ts";

export interface ArtifactUrls {
  demoUrl: string | null;
  stagingUrl: string | null;
  prUrl: string | null;
}

export function hasAnyArtifact(u: ArtifactUrls): boolean {
  return !!(u.demoUrl || u.stagingUrl || u.prUrl);
}

type LinkKey = "demo" | "staging" | "pr";

interface Link {
  key: LinkKey;
  href: string;
  label: string;
  color: string;
  icon: string;
}

const META: Record<LinkKey, { label: string; color: string; icon: string }> = {
  demo: { label: "demoを確認", color: t.primary, icon: "🌐" },
  staging: { label: "stagingを確認", color: t.success, icon: "🚀" },
  pr: { label: "PR を開く", color: t.borderStrong, icon: "🔀" },
};

function urlFor(u: ArtifactUrls, key: LinkKey): string | null {
  return key === "demo" ? u.demoUrl : key === "staging" ? u.stagingUrl : u.prUrl;
}

/**
 * Which env the task has reached: 0=demo, 1=staging, 2=本番. Taken from the feature phase,
 * but a captured staging URL alone also counts as "staging反映済み" (the OR-condition: the
 * phase text can lag behind the actual deploy). No `phase` → infer from the URLs present.
 */
function reachedRank(phase: FeaturePhase | undefined, u: ArtifactUrls): number {
  let rank = 0;
  if (phase === "prod_shipped") rank = 2;
  else if (
    phase === "staging_deployed" ||
    phase === "staging_review" ||
    phase === "staging_rejected"
  ) {
    rank = 1;
  }
  if (rank < 1 && u.stagingUrl) rank = 1; // staging_url が有る = staging反映済み
  return rank;
}

/**
 * staging に到達済み（phase 由来）なのに run 出力から staging URL を拾えていない時、Dub の固定
 * staging ホストで補完する。これにより「stagingに反映済み」バッジ（phase 由来）と主 URL が常に一致し、
 * 「バッジは staging・URL は demo」の不整合が起きない。すでに staging URL が有れば何もしない。
 */
function withStagingFallback(u: ArtifactUrls, phase?: FeaturePhase): ArtifactUrls {
  if (u.stagingUrl) return u;
  return reachedRank(phase, u) >= 1 ? { ...u, stagingUrl: DUB_STAGING_URL } : u;
}

/**
 * The link the operator should look at now — the reached env's URL. Staging に到達していれば
 * staging URL（未取得なら固定ホストで補完）を主にするので、demo へ降格しない。本番 uses the PR as
 * its shipped-record reference then staging (consistent with reflection.ts's prod url).
 */
export function primaryKey(u: ArtifactUrls, phase?: FeaturePhase): LinkKey | null {
  u = withStagingFallback(u, phase);
  const rank = reachedRank(phase, u);
  if (rank >= 2) {
    if (u.prUrl) return "pr";
    if (u.stagingUrl) return "staging";
    if (u.demoUrl) return "demo";
  }
  if (rank >= 1) {
    if (u.stagingUrl) return "staging";
    if (u.demoUrl) return "demo";
    if (u.prUrl) return "pr";
  }
  if (u.demoUrl) return "demo";
  if (u.stagingUrl) return "staging";
  if (u.prUrl) return "pr";
  return null;
}

function makeLink(u: ArtifactUrls, key: LinkKey): Link | null {
  const href = urlFor(u, key);
  if (!href) return null;
  return { key, href, ...META[key] };
}

/** Split captured links into the primary (reached env) and the rest (fixed demo→staging→pr order). */
function splitLinks(u: ArtifactUrls, phase?: FeaturePhase): { primary: Link | null; secondary: Link[] } {
  const eff = withStagingFallback(u, phase);
  const pk = primaryKey(u, phase);
  const primary = pk ? makeLink(eff, pk) : null;
  const order: LinkKey[] = ["demo", "staging", "pr"];
  const secondary = order
    .filter((k) => k !== pk)
    .map((k) => makeLink(eff, k))
    .filter((l): l is Link => l !== null);
  return { primary, secondary };
}

export function ArtifactLinks({
  urls,
  variant,
  phase,
  running,
}: {
  urls: ArtifactUrls;
  variant: "card" | "drawer";
  /** Feature phase — decides which env's URL is the primary (large) link. */
  phase?: FeaturePhase;
  /** When true and nothing found yet, show a "URL待ち" skeleton instead of an empty note. */
  running?: boolean;
}) {
  const { primary, secondary } = splitLinks(urls, phase);

  if (!primary) {
    if (variant === "card") return null; // cards stay quiet until a URL exists
    return running ? (
      <div
        data-testid="artifact-skeleton"
        aria-label="成果物URLを待っています"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: t.space2,
        }}
      >
        {[0, 1].map((i) => (
          <div
            key={i}
            aria-hidden
            style={{
              height: 44,
              borderRadius: t.radius,
              background: t.surface,
              border: `1px solid ${t.border}`,
              opacity: 0.5,
            }}
          />
        ))}
        <span style={{ fontSize: 12, color: t.textMuted }}>
          実行の出力から demo / staging / PR の URL を待っています…
        </span>
      </div>
    ) : (
      <div data-testid="artifact-empty" style={{ fontSize: 13, color: t.textMuted }}>
        まだ成果物 URL は検出されていません（デプロイ / PR 作成後に自動で表示されます）。
      </div>
    );
  }

  if (variant === "card") {
    return (
      <div
        data-testid="artifact-chips"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: t.space2, marginTop: t.space2 }}
      >
        <CardChip link={primary} primary />
        {secondary.map((l) => (
          <CardChip key={l.key} link={l} />
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="artifact-links"
      style={{ display: "flex", flexDirection: "column", gap: t.space3 }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, letterSpacing: 0.3 }}>
        今確認する環境
      </span>
      <DrawerButton link={primary} primary />

      {secondary.length > 0 && (
        <details data-testid="artifact-secondary">
          <summary
            style={{
              fontSize: 12,
              color: t.textMuted,
              cursor: "pointer",
              padding: `${t.space1} 0`,
              userSelect: "none",
            }}
          >
            他の環境の URL（{secondary.map((l) => l.key).join(" / ")}）
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: t.space2, marginTop: t.space2 }}>
            {secondary.map((l) => (
              <DrawerButton key={l.key} link={l} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CardChip({ link: l, primary }: { link: Link; primary?: boolean }) {
  return (
    <a
      href={l.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`artifact-chip-${l.key}`}
      data-primary={primary ? "true" : undefined}
      onClick={(e) => e.stopPropagation()}
      title={l.href}
      style={chipStyle(l.color, primary)}
    >
      {l.icon} {primary ? (l.key === "pr" ? "PR" : `${l.key} ✓今ここ`) : l.key === "pr" ? "PR" : l.key}
    </a>
  );
}

function DrawerButton({ link: l, primary }: { link: Link; primary?: boolean }) {
  return (
    <a
      href={l.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`artifact-link-${l.key}`}
      data-primary={primary ? "true" : undefined}
      style={buttonStyle(l.color, primary)}
    >
      <span style={{ fontSize: primary ? 18 : 15 }}>{l.icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
        <span style={{ fontWeight: primary ? 800 : 600, fontSize: primary ? 15 : 13 }}>{l.label}</span>
        <span
          style={{
            fontSize: 11,
            opacity: 0.85,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {l.href}
        </span>
      </span>
      <span style={{ marginLeft: "auto", opacity: 0.8 }}>↗</span>
    </a>
  );
}

function chipStyle(color: string, primary?: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    color: primary ? "#fff" : color,
    textDecoration: "none",
    padding: primary ? `3px ${t.space3}` : `2px ${t.space2}`,
    borderRadius: "var(--dub-radius-sm, 8px)",
    border: `1px solid ${color}`,
    background: primary ? color : "transparent",
    opacity: primary ? 1 : 0.75,
  };
}

function buttonStyle(color: string, primary?: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: t.space3,
    padding: primary ? t.space4 : t.space2,
    borderRadius: t.radius,
    border: `1px solid ${color}`,
    borderLeft: `${primary ? 5 : 3}px solid ${color}`,
    background: t.surface,
    color: "inherit",
    textDecoration: "none",
    opacity: primary ? 1 : 0.85,
  };
}
