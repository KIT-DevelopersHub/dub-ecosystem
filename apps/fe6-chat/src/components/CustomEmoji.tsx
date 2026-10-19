/// <reference lib="dom" />
// Workspace custom emoji on the client: the list (loaded once per chat screen), an
// image cache (one authenticated fetch per image -> object URL, shared by every reaction
// chip and the picker), and the two render helpers:
//   <ReactionEmoji emoji=":name:" />  image when `name` is a known custom emoji, else text
//   <CustomEmojiImage name="name" />  the image itself (skeleton while loading, text on error)
// Images go through the chat API client (cookie session, same as every chat call) rather
// than a bare <img src>, so they work with the cross-site gateway and in the demo transport.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatApiClient } from "../api/client";
import type { CustomEmoji } from "../api/contract";
import { resolveCustomEmoji, shortcodeName, toShortcode } from "../lib/custom-emoji";
import styles from "../styles/chat.module.css";

export interface CustomEmojiContextValue {
  /** null = still loading. */
  emojis: CustomEmoji[] | null;
  /** The list request failed (reactions fall back to text). */
  failed: boolean;
  byName: ReadonlyMap<string, CustomEmoji>;
  reload: () => Promise<void>;
  /** Object URL of an image name (cached; null = unavailable). */
  loadImage: (imageName: string) => Promise<string | null>;
  /** Opens the Slack import modal; null when the caller may not import. */
  openImport: (() => void) | null;
}

const CustomEmojiContext = createContext<CustomEmojiContextValue | null>(null);

/** null outside a provider (bare unit tests): callers render plain text. */
export function useCustomEmojis(): CustomEmojiContextValue | null {
  return useContext(CustomEmojiContext);
}

export function CustomEmojiProvider({ api, onOpenImport, children }: { api: ChatApiClient; onOpenImport?: () => void; children: ReactNode }) {
  const [emojis, setEmojis] = useState<CustomEmoji[] | null>(null);
  const [failed, setFailed] = useState(false);
  const images = useRef(new Map<string, Promise<string | null>>());
  const urls = useRef<string[]>([]);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const list = await api.listCustomEmojis();
      setEmojis(list);
      setFailed(false);
    } catch {
      setEmojis((cur) => cur ?? []);
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Object URLs live as long as the provider. An image that resolves after unmount is
  // revoked on arrival instead of leaking. (StrictMode's fake unmount re-arms `mounted`.)
  useEffect(() => {
    mounted.current = true;
    const created = urls.current;
    const cache = images.current;
    return () => {
      mounted.current = false;
      for (const u of created.splice(0)) URL.revokeObjectURL?.(u);
      cache.clear();
    };
  }, []);

  const loadImage = useCallback(
    (imageName: string) => {
      let p = images.current.get(imageName);
      if (!p) {
        p = api.customEmojiImage(imageName).then(
          (blob) => {
            if (typeof URL.createObjectURL !== "function") return null;
            const url = URL.createObjectURL(blob);
            if (!mounted.current) {
              URL.revokeObjectURL?.(url);
              images.current.delete(imageName);
              return null;
            }
            urls.current.push(url);
            return url;
          },
          () => {
            images.current.delete(imageName); // a later render may retry
            return null;
          },
        );
        images.current.set(imageName, p);
      }
      return p;
    },
    [api],
  );

  const byName = useMemo(() => new Map((emojis ?? []).map((e) => [e.name, e] as const)), [emojis]);
  const openImport = onOpenImport ?? null;
  const value = useMemo<CustomEmojiContextValue>(
    () => ({ emojis, failed, byName, reload, loadImage, openImport }),
    [emojis, failed, byName, reload, loadImage, openImport],
  );
  return <CustomEmojiContext.Provider value={value}>{children}</CustomEmojiContext.Provider>;
}

export interface CustomEmojiImageProps {
  /** Emoji name as typed in `:name:` (an alias resolves to its target's image). */
  name: string;
  className?: string;
  /** Start loading only when scrolled into view (picker grid). */
  lazy?: boolean;
}

export function CustomEmojiImage({ name, className, lazy = false }: CustomEmojiImageProps) {
  const ctx = useCustomEmojis();
  const target = ctx ? resolveCustomEmoji(ctx.byName, name) : null;
  const [url, setUrl] = useState<string | null | undefined>(undefined); // undefined = loading
  const [visible, setVisible] = useState(!lazy || typeof IntersectionObserver === "undefined");
  const holder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (visible || !holder.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    });
    io.observe(holder.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!ctx || !target || !visible) return;
    let alive = true;
    void ctx.loadImage(target.name).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [ctx, target, visible]);

  const label = toShortcode(name);
  const cls = `${styles.customEmoji} ${className ?? ""}`;
  if (!target || url === null) return <span title={label}>{label}</span>;
  if (url === undefined) {
    return <span ref={holder} className={`${cls} ${styles.customEmojiLoading}`} role="img" aria-label={label} data-testid="fe6-custom-emoji-loading" />;
  }
  return <img src={url} alt={label} title={label} className={cls} draggable={false} data-testid="fe6-custom-emoji" data-emoji-name={name} />;
}

/** One reaction's emoji: the custom image for a known ":name:", the text otherwise. */
export function ReactionEmoji({ emoji }: { emoji: string }) {
  const ctx = useCustomEmojis();
  const name = shortcodeName(emoji);
  if (!ctx || !name) return <span>{emoji}</span>;
  // List still loading: hold the slot (skeleton) instead of flashing ":name:" text.
  if (ctx.emojis === null) {
    return <span className={`${styles.customEmoji} ${styles.customEmojiLoading}`} role="img" aria-label={emoji} data-testid="fe6-custom-emoji-loading" />;
  }
  if (!resolveCustomEmoji(ctx.byName, name)) return <span>{emoji}</span>;
  return <CustomEmojiImage name={name} />;
}
