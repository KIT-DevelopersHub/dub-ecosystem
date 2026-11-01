/// <reference lib="dom" />
// Slack-style quote card for links to messages of this app (「リンクをコピー」 URLs)
// and for forwarded posts. The linked message comes from the open timeline when it is
// already loaded, else from the existing GET /chat/messages (afterMessageId window);
// both are memoized per message for the session. Loading = skeleton card; no access /
// deleted / gone = a quiet 「メッセージを表示できません」 card. Without a lookup
// provider (bare renders) the card still links to the message.
import { createContext, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Avatar, Skeleton } from "@dub/ui";
import type { common, identity } from "@dub/types";
import type { Message, TeamSummary } from "../api/contract";
import type { ChatApiClient } from "../api/client";
import { useOptionalChatRuntime } from "../context";
import { extractPreviewUrls } from "../lib/render-body";
import { parseMessageLink, type MessageLink, type ParsedForward } from "../lib/forward";
import { MessageBody } from "./MessageBody";
import styles from "../styles/chat.module.css";

// Liveness marker: verify-live asserts this literal is in the served bundle.
export const MESSAGE_UNFURL_MARKER = "fe6-msg-unfurl";

export const MAX_MESSAGE_UNFURLS = 2;

export interface MessageLookup {
  /** A message already in the open timeline / thread (fresh, no request). */
  findLoaded: (id: common.MessageId) => Message | undefined;
  resolveUser: (id: common.UserId) => identity.UserSummary | undefined;
  resolveTeam?: (id: string) => TeamSummary | undefined;
  resolveChannelName: (id: common.ChannelId) => string | undefined;
  /** Jump to the linked message (switching channel if needed). */
  onOpen: (link: MessageLink) => void;
}

export const MessageLookupContext = createContext<MessageLookup | null>(null);

const messageCache = new Map<string, Promise<Message | null>>();
const userCache = new Map<common.UserId, Promise<identity.UserSummary | null>>();

/** Test hook: forget memoized lookups. */
export function resetMessageUnfurlCache(): void {
  messageCache.clear();
  userCache.clear();
}

/** The id sorting right before `id` (same length), so `afterMessageId` starts at it. */
export function predecessorId(id: string): string {
  if (id.length === 0) return id;
  return id.slice(0, -1) + String.fromCharCode(id.charCodeAt(id.length - 1) - 1);
}

function fetchMessage(api: ChatApiClient, link: MessageLink): Promise<Message | null> {
  const key = `${link.channelId}/${link.messageId}`;
  let p = messageCache.get(key);
  if (!p) {
    p = api
      .listMessages({
        channelId: link.channelId,
        afterMessageId: predecessorId(link.messageId) as common.MessageId,
        limit: 5,
        ...(link.threadRootId ? { threadRootId: link.threadRootId } : {}),
      })
      .then((res) => res.items.find((m) => m.id === link.messageId) ?? null)
      .catch(() => {
        // 404 / 403 stay "unavailable" for this mount; a later mount retries (offline blip).
        messageCache.delete(key);
        return null;
      });
    messageCache.set(key, p);
  }
  return p;
}

function fetchUser(api: ChatApiClient, id: common.UserId): Promise<identity.UserSummary | null> {
  let p = userCache.get(id);
  if (!p) {
    p = api
      .resolveUsers([id])
      .then((list) => list.find((u) => u.id === id) ?? null)
      .catch(() => {
        userCache.delete(id);
        return null;
      });
    userCache.set(id, p);
  }
  return p;
}

type State = { kind: "loading" } | { kind: "ok"; message: Message } | { kind: "unavailable"; deleted: boolean };

function useLinkedMessage(link: MessageLink): State {
  const runtime = useOptionalChatRuntime();
  const lookup = useContext(MessageLookupContext);
  const loaded = lookup?.findLoaded(link.messageId);
  const [fetched, setFetched] = useState<State>({ kind: "loading" });
  useEffect(() => {
    if (loaded) return;
    if (!runtime) {
      setFetched({ kind: "unavailable", deleted: false });
      return;
    }
    let alive = true;
    setFetched({ kind: "loading" });
    void fetchMessage(runtime.api, link).then((m) => {
      if (!alive) return;
      setFetched(m ? { kind: "ok", message: m } : { kind: "unavailable", deleted: false });
    });
    return () => {
      alive = false;
    };
    // link fields, not the object: a re-render parses a fresh one
  }, [runtime, loaded, link.channelId, link.messageId, link.threadRootId]); // eslint-disable-line react-hooks/exhaustive-deps
  const state: State = loaded ? { kind: "ok", message: loaded } : fetched;
  if (state.kind === "ok" && state.message.deletedAt !== null) return { kind: "unavailable", deleted: true };
  return state;
}

function useAuthor(id: common.UserId | null): identity.UserSummary | undefined {
  const runtime = useOptionalChatRuntime();
  const lookup = useContext(MessageLookupContext);
  const known = id ? lookup?.resolveUser(id) : undefined;
  const [fetched, setFetched] = useState<identity.UserSummary | undefined>(undefined);
  useEffect(() => {
    if (!id || known || !runtime) return;
    let alive = true;
    void fetchUser(runtime.api, id).then((u) => alive && u && setFetched(u));
    return () => {
      alive = false;
    };
  }, [id, known, runtime]);
  return known ?? fetched;
}

function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Shared chrome of the unfurl + forward cards: left bar, author, body, footer. The
 * body may hold links, so the card is not an <a>: clicking its empty area opens the
 * message, and the footer 「メッセージを表示」 is the real (keyboard / new-tab) link.
 */
export function QuoteCard({
  authorName,
  avatarUrl,
  footer,
  href,
  onOpen,
  testId,
  children,
}: {
  authorName: string;
  avatarUrl?: string | undefined;
  footer: ReactNode;
  href?: string | undefined;
  onOpen?: (() => void) | undefined;
  testId: string;
  children: ReactNode;
}) {
  const open = (e: MouseEvent) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen();
  };
  return (
    <div
      className={`${styles.quoteCard} ${href ? styles.quoteCardLink : ""}`}
      data-testid={testId}
      data-marker={MESSAGE_UNFURL_MARKER}
      onClick={(e) => {
        // a link inside the quoted text keeps its own behaviour
        if (href && !(e.target as HTMLElement).closest("a")) open(e);
      }}
    >
      <span className={styles.quoteCardAuthor}>
        <Avatar name={authorName} src={avatarUrl} size="sm" />
        <span className={styles.quoteCardName}>{authorName}</span>
      </span>
      <span className={styles.quoteCardBody}>{children}</span>
      <span className={styles.quoteCardFooter}>
        {footer}
        {href && (
          <a className={styles.quoteCardView} href={href} data-testid={`${testId}-open`} onClick={open}>
            メッセージを表示
          </a>
        )}
      </span>
    </div>
  );
}

function MessageLinkCard({ href, link }: { href: string; link: MessageLink }) {
  const lookup = useContext(MessageLookupContext);
  const state = useLinkedMessage(link);
  const message = state.kind === "ok" ? state.message : null;
  const author = useAuthor(message?.authorId ?? null);
  const open = lookup ? () => lookup.onOpen(link) : undefined;

  if (state.kind === "loading") {
    return (
      <div className={styles.quoteCard} data-testid="fe6-msg-unfurl-loading" aria-busy="true" aria-label="メッセージを読み込み中">
        <span className={styles.quoteCardAuthor}>
          <Skeleton variant="circle" width={20} height={20} />
          <Skeleton variant="text" width="6em" />
        </span>
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="text" width="10em" />
      </div>
    );
  }
  if (!message) {
    return (
      <div className={`${styles.quoteCard} ${styles.quoteCardMuted}`} data-testid="fe6-msg-unfurl-unavailable" data-marker={MESSAGE_UNFURL_MARKER}>
        {state.kind === "unavailable" && state.deleted ? "このメッセージは削除されました" : "メッセージを表示できません"}
      </div>
    );
  }
  const authorName = message.authorId === null ? "システム" : (author?.displayName ?? "メンバー");
  const channelName = lookup?.resolveChannelName(message.channelId) ?? "チャンネル";
  return (
    <QuoteCard
      authorName={authorName}
      avatarUrl={author?.avatarUrl ?? undefined}
      href={href}
      onOpen={open}
      testId="fe6-msg-unfurl"
      footer={
        <>
          {message.threadRootId ? `${channelName} のスレッドに返信` : `${channelName} に投稿`} · {dateTime(message.createdAt)}
        </>
      }
    >
      {message.body.trim() ? (
        <MessageBody body={message.body} resolveUser={lookup?.resolveUser} resolveTeam={lookup?.resolveTeam} />
      ) : (
        "(添付ファイル)"
      )}
    </QuoteCard>
  );
}

/** Message links found in `body` (current / known origin), at most MAX_MESSAGE_UNFURLS. */
export function messageLinksIn(body: string, origin: string | undefined, selfId?: common.MessageId): { href: string; link: MessageLink }[] {
  const out: { href: string; link: MessageLink }[] = [];
  for (const href of extractPreviewUrls(body, 10)) {
    const link = parseMessageLink(href, origin);
    if (!link || link.messageId === selfId) continue;
    out.push({ href, link });
    if (out.length >= MAX_MESSAGE_UNFURLS) break;
  }
  return out;
}

export function MessageUnfurls({ body, selfId }: { body: string; selfId?: common.MessageId }) {
  const links = useMemo(() => messageLinksIn(body, globalThis.location?.origin, selfId), [body, selfId]);
  if (links.length === 0) return null;
  return (
    <div className={styles.quoteCards} data-testid="fe6-msg-unfurls">
      {links.map(({ href, link }) => (
        <MessageLinkCard key={href} href={href} link={link} />
      ))}
    </div>
  );
}

/** A forwarded post (buildForwardBody) drawn as the same card as a link unfurl. */
export function ForwardedCard({ forward }: { forward: ParsedForward }) {
  const lookup = useContext(MessageLookupContext);
  const link = forward.link ? parseMessageLink(forward.link, globalThis.location?.origin) : null;
  return (
    <div className={styles.quoteCards}>
      <QuoteCard
        authorName={forward.authorName}
        href={link ? forward.link! : undefined}
        onOpen={link && lookup ? () => lookup.onOpen(link) : undefined}
        testId="fe6-msg-forwarded"
        footer={`${forward.sourceChannelName} から転送`}
      >
        <MessageBody body={forward.text} resolveUser={lookup?.resolveUser} resolveTeam={lookup?.resolveTeam} />
      </QuoteCard>
    </div>
  );
}
