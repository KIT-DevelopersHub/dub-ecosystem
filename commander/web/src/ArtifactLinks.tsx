// Artifact URL links (P1-2) — the click-through the judgment loop closes on: 走らせる →
// URLが出る → クリックして確認. Auto-extracted from run output (service-side urls.ts) and
// stored on the task; here they render as links. Two variants:
//   - "card":   compact chips on a board card (never steal the card's open-click).
//   - "drawer": big, obvious "…を確認" buttons in the 成果物 tab.
// When nothing is captured yet: a "URL待ち" skeleton while running, else a quiet empty note.
import type { CSSProperties } from "react";
import { t } from "./lib/theme.ts";

export interface ArtifactUrls {
  demoUrl: string | null;
  stagingUrl: string | null;
  prUrl: string | null;
}

export function hasAnyArtifact(u: ArtifactUrls): boolean {
  return !!(u.demoUrl || u.stagingUrl || u.prUrl);
}

interface Link {
  key: "demo" | "staging" | "pr";
  href: string;
  label: string;
  color: string;
  icon: string;
}

function links(u: ArtifactUrls): Link[] {
  const out: Link[] = [];
  if (u.demoUrl) out.push({ key: "demo", href: u.demoUrl, label: "demoを確認", color: t.primary, icon: "🌐" });
  if (u.stagingUrl) out.push({ key: "staging", href: u.stagingUrl, label: "stagingを確認", color: t.success, icon: "🚀" });
  if (u.prUrl) out.push({ key: "pr", href: u.prUrl, label: "PR を開く", color: t.borderStrong, icon: "🔀" });
  return out;
}

export function ArtifactLinks({
  urls,
  variant,
  running,
}: {
  urls: ArtifactUrls;
  variant: "card" | "drawer";
  /** When true and nothing found yet, show a "URL待ち" skeleton instead of an empty note. */
  running?: boolean;
}) {
  const items = links(urls);

  if (items.length === 0) {
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
        style={{ display: "flex", flexWrap: "wrap", gap: t.space2, marginTop: t.space2 }}
      >
        {items.map((l) => (
          <a
            key={l.key}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`artifact-chip-${l.key}`}
            onClick={(e) => e.stopPropagation()}
            title={l.href}
            style={chipStyle(l.color)}
          >
            {l.icon} {l.key === "pr" ? "PR" : l.key}
          </a>
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="artifact-links"
      style={{ display: "flex", flexDirection: "column", gap: t.space3 }}
    >
      {items.map((l) => (
        <a
          key={l.key}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`artifact-link-${l.key}`}
          style={buttonStyle(l.color)}
        >
          <span style={{ fontSize: 16 }}>{l.icon}</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
            <span style={{ fontWeight: 700 }}>{l.label}</span>
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
      ))}
    </div>
  );
}

function chipStyle(color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    color,
    textDecoration: "none",
    padding: `2px ${t.space2}`,
    borderRadius: "var(--dub-radius-sm, 8px)",
    border: `1px solid ${color}`,
    background: "transparent",
  };
}

function buttonStyle(color: string): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: t.space3,
    padding: t.space3,
    borderRadius: t.radius,
    border: `1px solid ${color}`,
    borderLeft: `4px solid ${color}`,
    background: t.surface,
    color: "inherit",
    textDecoration: "none",
  };
}
