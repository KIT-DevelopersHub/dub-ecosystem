// Round sender avatar (送信者アイコン). Shows the icon a Dub user set in アカウント設定 when the
// address belongs to an active roster user; everyone else (outside senders, users without an
// icon, lookup failures) keeps the coloured initial. Lookups are batched per tick across every
// avatar on screen and cached per MailApi for the session, so a list page costs one request.
import { useEffect, useState, useSyncExternalStore } from "react";
import { mail } from "@dub/types";
import { useOptionalMailApi } from "../MailProvider.tsx";
import type { MailApi } from "../mailApi.tsx";
import { avatarColor, initial, type MailPerson } from "./mailModel.ts";

class AvatarStore {
  /** email -> url, or null once resolved (or in flight) without one. */
  private readonly urls = new Map<string, string | null>();
  private readonly queued = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly api: MailApi) {}

  get = (email: string): string | null => this.urls.get(email) ?? null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  request(email: string): void {
    if (this.urls.has(email) || this.queued.has(email)) return;
    this.queued.add(email);
    this.timer ??= setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.timer = null;
    const emails = [...this.queued];
    this.queued.clear();
    for (const e of emails) this.urls.set(e, null);
    for (let i = 0; i < emails.length; i += mail.MAIL_AVATAR_LOOKUP_LIMIT) {
      const chunk = emails.slice(i, i + mail.MAIL_AVATAR_LOOKUP_LIMIT);
      Promise.resolve()
        .then(() => this.api.avatars(chunk))
        .then((res) => {
          const found = Object.entries(res?.avatars ?? {});
          if (found.length === 0) return;
          for (const [email, url] of found) this.urls.set(email, url);
          for (const fn of this.listeners) fn();
        })
        .catch(() => undefined);
    }
  }
}

const stores = new WeakMap<MailApi, AvatarStore>();
const NO_STORE = { get: () => null, subscribe: () => () => undefined, request: () => undefined };

function storeFor(api: MailApi | null): Pick<AvatarStore, "get" | "subscribe" | "request"> {
  if (!api) return NO_STORE;
  let s = stores.get(api);
  if (!s) stores.set(api, (s = new AvatarStore(api)));
  return s;
}

/** Avatar URL of the Dub user behind `email`, or null (not a Dub user / no icon / pending). */
export function useSenderAvatar(email: string): string | null {
  const store = storeFor(useOptionalMailApi());
  const key = email.trim().toLowerCase();
  useEffect(() => {
    if (key) store.request(key);
  }, [store, key]);
  return useSyncExternalStore(store.subscribe, () => (key ? store.get(key) : null));
}

export function SenderAvatar({ p, size = 36, fontSize = size * 0.42 }: { p: MailPerson; size?: number; fontSize?: number }): JSX.Element {
  const url = useSenderAvatar(p.email);
  const [broken, setBroken] = useState<string | null>(null);
  const showImage = url !== null && broken !== url;
  return (
    <span
      aria-hidden
      data-testid="fe2-mail-avatar"
      style={{
        position: "relative",
        overflow: "hidden",
        width: size,
        height: size,
        borderRadius: "var(--dub-radius-full)",
        background: avatarColor(p),
        color: "#fff",
        fontSize,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {initial(p)}
      {showImage ? (
        <img
          src={url}
          alt=""
          data-testid="fe2-mail-avatar-img"
          referrerPolicy="no-referrer"
          onError={() => setBroken(url)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
    </span>
  );
}

/** Small avatar in front of a recipient chip / suggestion (To・Cc・Bcc), Gmail-style. */
export function recipientIcon(p: MailPerson): JSX.Element {
  return <SenderAvatar p={p} size={18} />;
}
