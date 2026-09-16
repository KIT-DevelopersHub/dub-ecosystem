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
import styles from "../styles/chat.module.css";

// Liveness marker: verify-live asserts this literal is in the served bundle.
export const LINK_PREVIEW_MARKER = "chat-url-ogp-unfurl-v1";

const cache = new Map<string, Promise<UnfurlPreview | null>>();

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
  return <img className={styles.linkPreviewImage} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
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
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="fe6-link-preview"
          aria-label={`リンクプレビュー: ${p.title ?? p.url}`}
        >
          <span className={styles.linkPreviewText}>
            {p.siteName && <span className={styles.linkPreviewSite}>{p.siteName}</span>}
            <span className={styles.linkPreviewTitle}>{p.title ?? p.url}</span>
            {p.description && <span className={styles.linkPreviewDesc}>{p.description}</span>}
          </span>
          {p.imageUrl && <PreviewImage src={p.imageUrl} />}
        </a>
      ))}
    </div>
  );
}
