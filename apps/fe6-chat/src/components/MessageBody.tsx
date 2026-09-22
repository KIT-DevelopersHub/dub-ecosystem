// Renders a message body's Markdown-subset blocks + inline styles to React.
// Safe by construction: every value goes through React children (escaped) — no
// dangerouslySetInnerHTML — and links are sanitized to http(s)/relative only.
import type { common, identity } from "@dub/types";
import type { TeamSummary } from "../api/contract";
import { parseBlocks, type BodySegment } from "../lib/render-body";
import styles from "../styles/chat.module.css";

/** Display-name resolvers for the two mention kinds (person / 運営チーム). */
export interface MentionResolvers {
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  resolveTeam?: (id: string) => TeamSummary | undefined;
}

function nameOf(userId: string, resolve?: (id: common.UserId) => identity.UserSummary | undefined): string {
  return resolve?.(userId as common.UserId)?.displayName ?? userId;
}

// An unresolved team falls back to the raw id — never to an empty chip, so a
// stale/deleted team still reads as "a mention" instead of vanishing.
function teamNameOf(teamId: string, resolve?: (id: string) => TeamSummary | undefined): string {
  return resolve?.(teamId)?.name ?? teamId;
}

// Team accent colours are hex (member.Team.color). Anything else is ignored so a
// bad roster value can never reach the style attribute.
function teamColorOf(team: TeamSummary | undefined): string | null {
  const color = team?.color ?? null;
  return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : null;
}

// Only allow safe link targets (defense-in-depth; the parser already requires
// http(s)/relative, but re-check so a crafted body can never yield javascript: etc.)
function safeHref(href: string): string | null {
  if (/^https?:\/\//i.test(href) || href.startsWith("/")) return href;
  return null;
}

function Inlines({ segs, resolveUser, resolveTeam }: { segs: BodySegment[] } & MentionResolvers): JSX.Element {
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
          case "teamMention": {
            // チーム単位メンション: チーム色を帯びたチップで個人メンションと区別する。
            const color = teamColorOf(resolveTeam?.(seg.teamId));
            return (
              <span
                key={i}
                className={`${styles.mention} ${styles.mentionTeam}`}
                data-testid="fe6-team-mention"
                data-team-id={seg.teamId}
                {...(color ? { style: { color, background: `color-mix(in srgb, ${color} 14%, transparent)` } } : {})}
              >
                @{teamNameOf(seg.teamId, resolveTeam)}
              </span>
            );
          }
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

export function MessageBody({ body, resolveUser, resolveTeam }: { body: string } & MentionResolvers): JSX.Element {
  const blocks = parseBlocks(body);
  const resolvers: MentionResolvers = { resolveUser, resolveTeam };
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
                    <Inlines segs={line} {...resolvers} />
                  </div>
                ))}
              </blockquote>
            );
          case "bullet":
            return (
              <ul key={bi} className={styles.mdList}>
                {block.items.map((item, li) => (
                  <li key={li}>
                    <Inlines segs={item} {...resolvers} />
                  </li>
                ))}
              </ul>
            );
          case "ordered":
            return (
              <ol key={bi} className={styles.mdList}>
                {block.items.map((item, li) => (
                  <li key={li}>
                    <Inlines segs={item} {...resolvers} />
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
                    <Inlines segs={line} {...resolvers} />
                  </span>
                ))}
              </p>
            );
        }
      })}
    </>
  );
}
