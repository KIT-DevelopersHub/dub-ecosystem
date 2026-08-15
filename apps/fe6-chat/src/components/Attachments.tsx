// Renders a message's attachments: images inline (with a lightbox-on-click via
// a native <a> to the source), other files as a Slack-style file chip. In
// standalone/mock the `url` is a data: URL; with file-meta it is an object URL.
import type { Attachment } from "../api/contract";
import styles from "../styles/chat.module.css";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

function fileGlyph(mime: string): string {
  if (mime.includes("pdf")) return "📕";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜";
  if (mime.includes("sheet") || mime.includes("csv") || mime.includes("excel")) return "📊";
  return "📄";
}

export function Attachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className={styles.attachments} data-testid="fe6-attachments">
      {attachments.map((a) =>
        isImage(a.mime) && a.url ? (
          <a key={a.fileId} href={a.url} target="_blank" rel="noreferrer" className={styles.attachImageLink} title={a.name}>
            <img src={a.url} alt={a.name} className={styles.attachImage} />
          </a>
        ) : (
          <a
            key={a.fileId}
            href={a.url ?? "#"}
            target={a.url ? "_blank" : undefined}
            rel="noreferrer"
            className={styles.attachFile}
            title={a.name}
          >
            <span className={styles.attachGlyph} aria-hidden>
              {fileGlyph(a.mime)}
            </span>
            <span className={styles.attachMeta}>
              <span className={styles.attachName}>{a.name}</span>
              <span className={styles.attachSize}>{humanSize(a.size)}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}
