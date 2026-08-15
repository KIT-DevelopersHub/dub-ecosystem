// Self-authored generic line icons for the mail UI. Deliberately NOT Google
// assets — plain geometric strokes drawn from scratch, currentColor, so they
// inherit text colour and theme. Kept tiny and dependency-free (no lucide import
// from fe2). Add new glyphs here as the UI needs them.
import type { CSSProperties } from "react";

export type MailIconName =
  | "inbox"
  | "star"
  | "star-filled"
  | "send"
  | "draft"
  | "trash"
  | "archive"
  | "mail-open"
  | "reply"
  | "reply-all"
  | "forward"
  | "more"
  | "search"
  | "x"
  | "minus"
  | "expand"
  | "compose"
  | "menu"
  | "refresh"
  | "tag"
  | "paperclip"
  | "alert"
  | "chevron-down"
  | "check"
  | "image"
  | "file"
  | "download";

const PATHS: Record<MailIconName, JSX.Element> = {
  inbox: (
    <>
      <path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9z" />,
  "star-filled": (
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9z"
      fill="currentColor"
      stroke="none"
    />
  ),
  send: <path d="M4 12l16-7-7 16-2.5-6.5z" />,
  draft: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  archive: (
    <>
      <path d="M3 5h18v4H3z" />
      <path d="M5 9v10h14V9" />
      <path d="M10 13h4" />
    </>
  ),
  "mail-open": (
    <>
      <path d="M3 10l9-6 9 6v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 10l9 6 9-6" />
    </>
  ),
  reply: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9a6 6 0 0 1 6 6v1" />
    </>
  ),
  "reply-all": (
    <>
      <path d="M8 7l-5 5 5 5" />
      <path d="M13 7l-2 2 3 3-3 3 2 2" />
      <path d="M11 12h5a5 5 0 0 1 5 5v1" />
    </>
  ),
  forward: (
    <>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12h-9a6 6 0 0 0-6 6v1" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  minus: <path d="M5 12h14" />,
  expand: <path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7" />,
  compose: (
    <>
      <path d="M4 20h16" />
      <path d="M14 4l6 6-9 9H5v-6z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-4L4 9" />
      <path d="M4 5v4h4" />
      <path d="M4 13a8 8 0 0 0 14 4l2-2" />
      <path d="M20 19v-4h-4" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12l8-8h8v8l-8 8z" />
      <circle cx="15" cy="9" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  paperclip: <path d="M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />,
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12l5 5 9-11" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="M4 17l5-5 4 4 3-3 4 4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
};

export function MailIcon({
  name,
  size = 20,
  style,
  title,
}: {
  name: MailIconName;
  size?: number;
  style?: CSSProperties;
  title?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
