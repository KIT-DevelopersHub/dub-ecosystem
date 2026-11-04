// Mail body renderers shared by the 3-pane reading view and the thread detail route.
// Plain text gets its URLs turned into safe links (linkify.ts); HTML is sanitized
// (sanitize.tsx) and only styled here so its anchors wrap instead of overflowing.
import { useMemo, type CSSProperties } from "react";
import { linkifySegments } from "./linkify.ts";
import { sanitizeHtml } from "./sanitize.tsx";
import styles from "./MailBody.module.css";

export function LinkifiedText({ text, testId, style }: { text: string; testId?: string; style?: CSSProperties }): JSX.Element {
  const segments = useMemo(() => linkifySegments(text), [text]);
  return (
    // pre-wrap stays inline: a plain-text body must keep its line breaks even where the
    // CSS module is not loaded (tests assert it); the module adds URL wrapping.
    <div data-testid={testId} className={styles.text} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}>
      {segments.map((s, i) =>
        s.kind === "link" ? (
          <a key={i} className={styles.link} href={s.href} target="_blank" rel="noopener noreferrer">
            {s.text}
          </a>
        ) : (
          s.text
        ),
      )}
    </div>
  );
}

export function SanitizedHtml({ html, testId }: { html: string; testId?: string }): JSX.Element {
  const safe = useMemo(() => sanitizeHtml(html), [html]);
  // safe is an allowlisted subset produced by sanitize.tsx (no scripts/handlers/js: urls).
  return <div data-testid={testId} className={styles.html} dangerouslySetInnerHTML={{ __html: safe }} />;
}
