// A received HTML mail, sanitized (sanitize.tsx). Remote images stay off until the reader asks
// (they are how a sender learns you opened it); inline cid: images load from the message's own
// stored attachments, so showing them tells nobody anything.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { mail } from "@dub/types";
import type { AttachmentSource } from "../mailApi.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { sanitizeHtml } from "../sanitize.tsx";
import styles from "../MailBody.module.css";

/** The Content-IDs a sanitized body really uses. Read from the parsed markup, so an escaped
 *  id (&amp;) matches its attachment. */
export function usedContentIds(safeHtml: string): Set<string> {
  if (typeof DOMParser === "undefined") return new Set();
  const imgs = new DOMParser().parseFromString(safeHtml, "text/html").querySelectorAll("img[data-cid]");
  return new Set(Array.from(imgs).map((img) => img.getAttribute("data-cid") ?? ""));
}

/** Sanitize, or null if the markup defeats the sanitizer: the caller shows the text body. */
export function safeMailHtml(html: string, remoteImages: boolean): string | null {
  try {
    return sanitizeHtml(html, { remoteImages });
  } catch {
    return null;
  }
}

export function HtmlMailBody({
  safeHtml,
  html,
  messageId,
  attachments,
  source,
  onInlineFailed,
}: {
  /** safeMailHtml(html, false): the caller needs it too, to pick the renderer. */
  safeHtml: string;
  html: string;
  messageId: string;
  attachments: mail.MailAttachment[];
  source: AttachmentSource;
  /** These inline images could not load, so their files need a chip after all. */
  onInlineFailed: (attachmentId: string) => void;
}): JSX.Element {
  const api = useMailApi();
  const [remoteImages, setRemoteImages] = useState(false);
  const safe = useMemo(() => (remoteImages ? (safeMailHtml(html, true) ?? safeHtml) : safeHtml), [html, remoteImages, safeHtml]);
  const blocked = !remoteImages && safe.includes("data-src=");
  const ref = useRef<HTMLDivElement>(null);
  const [cidUrls, setCidUrls] = useState<Record<string, string>>({});

  const inline = useMemo(() => {
    const used = usedContentIds(safe);
    return attachments.filter((a) => a.contentId && used.has(a.contentId) && (a.status === undefined || a.status === "stored"));
  }, [attachments, safe]);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void Promise.all(
      inline.map(async (a) => {
        try {
          const blob = await api.downloadAttachment(source, messageId, a.id);
          const url = URL.createObjectURL(blob);
          urls.push(url);
          return [a.contentId!, url] as const;
        } catch {
          if (alive) onInlineFailed(a.id);
          return null;
        }
      }),
    ).then((pairs) => {
      if (alive) setCidUrls(Object.fromEntries(pairs.filter((p) => p !== null)));
    });
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // onInlineFailed only adds to a set; a new identity is no reason to download again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, inline, messageId, source]);

  useLayoutEffect(() => {
    for (const img of Array.from(ref.current?.querySelectorAll<HTMLImageElement>("img[data-cid]") ?? [])) {
      const url = cidUrls[img.dataset.cid ?? ""];
      if (url) img.src = url;
    }
  }, [cidUrls, safe]);

  return (
    <div style={{ marginTop: 16, marginLeft: 48, minWidth: 0 }}>
      {blocked ? (
        <div className={styles.imagesNotice} data-testid="fe2-mail-images-blocked">
          <span>画像は表示されていません。</span>
          <button type="button" className={styles.imagesButton} data-testid="fe2-mail-images-show" onClick={() => setRemoteImages(true)}>
            画像を表示
          </button>
        </div>
      ) : null}
      {/* safe is the allowlisted subset from sanitize.tsx (no scripts, handlers or unsafe URLs). */}
      <div ref={ref} data-testid="fe2-mail-body-html" className={styles.mailHtml} dangerouslySetInnerHTML={{ __html: safe }} />
    </div>
  );
}
