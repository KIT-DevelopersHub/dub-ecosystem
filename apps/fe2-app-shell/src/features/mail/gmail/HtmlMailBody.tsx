// A received HTML mail, sanitized (sanitize.tsx). Remote images stay off until the reader asks
// (they are how a sender learns you opened it); inline cid: images load from the message's own
// stored attachments, so showing them tells nobody anything.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { mail } from "@dub/types";
import type { AttachmentSource } from "../mailApi.tsx";
import { useMailApi } from "../MailProvider.tsx";
import { sanitizeHtml } from "../sanitize.tsx";
import styles from "../MailBody.module.css";

export function HtmlMailBody({
  html,
  messageId,
  attachments,
  source,
}: {
  html: string;
  messageId: string;
  attachments: mail.MailAttachment[];
  source: AttachmentSource;
}): JSX.Element {
  const api = useMailApi();
  const [remoteImages, setRemoteImages] = useState(false);
  const safe = useMemo(() => sanitizeHtml(html, { remoteImages }), [html, remoteImages]);
  const blocked = !remoteImages && safe.includes("data-src=");
  const ref = useRef<HTMLDivElement>(null);
  const [cidUrls, setCidUrls] = useState<Record<string, string>>({});

  const inline = useMemo(() => attachments.filter((a) => a.contentId && (a.status === undefined || a.status === "stored")), [attachments]);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void Promise.all(
      inline.map(async (a) => {
        if (!safe.includes(`data-cid="${a.contentId}"`)) return null;
        const blob = await api.downloadAttachment(source, messageId, a.id);
        if (typeof URL.createObjectURL !== "function") return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return [a.contentId!, url] as const;
      }),
    )
      .then((pairs) => {
        if (alive) setCidUrls(Object.fromEntries(pairs.filter((p) => p !== null)));
      })
      .catch(() => undefined); // the image stays blank; its download chip is hidden only once shown
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [api, inline, messageId, safe, source]);

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

/** Inline images shown in the body, which therefore need no chip in the attachment strip. */
export function inlineContentIds(html: string | undefined, attachments: mail.MailAttachment[]): Set<string> {
  const ids = new Set<string>();
  if (html) for (const a of attachments) if (a.contentId && html.includes(`cid:${a.contentId}`)) ids.add(a.id);
  return ids;
}
