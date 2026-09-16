// Slack-style link preview (unfurl) cards rendered under a message body for the
// first 1-2 http(s) URLs it contains. Data comes from ChatApiClient.unfurl (server-
// side OGP resolve; mock table in demo). Best-effort by design: no runtime, a
// blocked URL, or a page without OGP simply renders NO card — the body's inline
// link stays. Results are memoized per URL for the session (module cache) so a
// re-render / re-mount of the timeline never refetches.
import { useEffect, useState } from "react";
import type { UnfurlPreview } from "../api/contract";
import { useOptionalChatRuntime } from "../context";
import { extractPreviewUrls } from "../lib/render-body";
import { safeHref } from "./MessageBody";
import styles from "../styles/chat.module.css";

// Liveness marker: verify-live asserts this literal is in the served bundle.
export const LINK_PREVIEW_MARKER = "chat-url-ogp-unfurl-v1";

const cache = new Map<string, Promise<UnfurlPreview | null>>();

// Thumbnails: https only (mixed content / intranet pings otherwise) plus inline
// data:image/* (inert inside <img>; used by the backend-free demo table).
const SAFE_IMG_RE = /^(?:https:\/\/|data:image\/)/i;

/** Test/HMR hook: forget memoized previews. */
export function resetLinkPreviewCache(): void {
  cache.clear();
}

function usePreviews(urls: string[]): UnfurlPreview[] {
  const runtime = useOptionalChatRuntime();
  const key = urls.join("\n");
  const [previews, setPreviews] = useState<UnfurlPreview[]>([]);
  useEffect(() => {
    if (!runtime || urls.length === 0) {
      setPreviews([]);
      return;
    }
    let alive = true;
    const jobs = urls.map((u) => {
      let p = cache.get(u);
      if (!p) {
        p = runtime.api.unfurl(u).catch(() => null);
        cache.set(u, p);
      }
      return p;
    });
    void Promise.all(jobs).then((res) => {
      if (alive) setPreviews(res.filter((p): p is UnfurlPreview => p !== null));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key]);
  return previews;
}

/** Thumbnail that removes itself when the remote image fails (broken-image icon is
 *  worse than a text-only card). */
function PreviewImage({ src }: { src: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className={styles.linkPreviewImage}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Source line: og:site_name, else the hostname (provenance is the anti-phishing cue). */
function siteOf(p: UnfurlPreview): string {
  if (p.siteName) return p.siteName;
  try {
    return new URL(p.url).hostname.replace(/^www\./, "");
  } catch {
    return p.url;
  }
}

export function LinkPreviews({ body }: { body: string }): JSX.Element | null {
  const urls = extractPreviewUrls(body, 2);
  const previews = usePreviews(urls);
  if (previews.length === 0) return null;
  return (
    <div className={styles.linkPreviews} data-testid="fe6-link-previews" data-marker={LINK_PREVIEW_MARKER}>
      {previews.map((p) => (
        <a
          key={p.url}
          className={styles.linkPreview}
          // defense-in-depth: the server/mock guarantees http(s), re-check like MessageBody
          href={safeHref(p.url) ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="fe6-link-preview"
          title="リンクプレビュー（新しいタブで開く）"
        >
          <span className={styles.linkPreviewText}>
            <span className={styles.linkPreviewSite}>{siteOf(p)}</span>
            <span className={styles.linkPreviewTitle}>{p.title ?? p.url}</span>
            {p.description && <span className={styles.linkPreviewDesc}>{p.description}</span>}
          </span>
          {p.imageUrl && SAFE_IMG_RE.test(p.imageUrl) && <PreviewImage src={p.imageUrl} />}
        </a>
      ))}
    </div>
  );
}
