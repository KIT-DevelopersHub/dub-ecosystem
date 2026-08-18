// Renders a message body's Markdown-subset blocks + inline styles to React.
// Safe by construction: every value goes through React children (escaped) — no
// dangerouslySetInnerHTML — and links are sanitized to http(s)/relative only.
import type { common, identity } from "@dub/types";
import { parseBlocks, type BodySegment } from "../lib/render-body";
import styles from "../styles/chat.module.css";

function nameOf(userId: string, resolve?: (id: common.UserId) => identity.UserSummary | undefined): string {
  return resolve?.(userId as common.UserId)?.displayName ?? userId;
}

// Only allow safe link targets (defense-in-depth; the parser already requires
// http(s)/relative, but re-check so a crafted body can never yield javascript: etc.)
function safeHref(href: string): string | null {
  if (/^https?:\/\//i.test(href) || href.startsWith("/")) return href;
  return null;
}

function Inlines({
  segs,
  resolveUser,
}: {
  segs: BodySegment[];
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
}): JSX.Element {
  return (
    <>
      {segs.map((seg, i) => {
        switch (seg.type) {
          case "mention":
            return (
              <span key={i} className={styles.mention}>
                @{nameOf(seg.userId, resolveUser)}
              </span>
            );
          case "code":
            return (
              <code key={i} className={styles.inlineCode}>
                {seg.value}
              </code>
            );
          case "bold":
            return (
              <strong key={i} className={styles.mdBold}>
                {seg.value}
              </strong>
            );
          case "italic":
            return (
              <em key={i} className={styles.mdItalic}>
                {seg.value}
              </em>
            );
          case "underline":
            return (
              <u key={i} className={styles.mdUnderline}>
                {seg.value}
              </u>
            );
          case "strike":
            return (
              <s key={i} className={styles.mdStrike}>
                {seg.value}
              </s>
            );
          case "link": {
            const href = safeHref(seg.href);
            return href ? (
              <a key={i} className={styles.mdLink} href={href} target="_blank" rel="noreferrer">
                {seg.label}
              </a>
            ) : (
              <span key={i}>{seg.label}</span>
            );
          }
          default:
            return <span key={i}>{seg.value}</span>;
        }
      })}
    </>
  );
}

export function MessageBody({
  body,
  resolveUser,
}: {
  body: string;
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
}): JSX.Element {
  const blocks = parseBlocks(body);
  return (
    <>
      {blocks.map((block, bi) => {
        switch (block.type) {
          case "codeblock":
            return (
              <pre key={bi} className={styles.codeBlock}>
                <code>{block.value}</code>
              </pre>
            );
          case "blockquote":
            return (
              <blockquote key={bi} className={styles.mdQuote}>
                {block.lines.map((line, li) => (
                  <div key={li}>
                    <Inlines segs={line} resolveUser={resolveUser} />
                  </div>
                ))}
              </blockquote>
            );
          case "bullet":
            return (
              <ul key={bi} className={styles.mdList}>
                {block.items.map((item, li) => (
                  <li key={li}>
                    <Inlines segs={item} resolveUser={resolveUser} />
                  </li>
                ))}
              </ul>
            );
          case "ordered":
            return (
              <ol key={bi} className={styles.mdList}>
                {block.items.map((item, li) => (
                  <li key={li}>
                    <Inlines segs={item} resolveUser={resolveUser} />
                  </li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={bi} className={styles.mdParagraph}>
                {block.lines.map((line, li) => (
                  <span key={li}>
                    {li > 0 && <br />}
                    <Inlines segs={line} resolveUser={resolveUser} />
                  </span>
                ))}
              </p>
            );
        }
      })}
    </>
  );
}
