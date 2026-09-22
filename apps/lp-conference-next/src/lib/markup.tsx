import { Fragment, type ReactNode } from "react";

// `**...**` を <strong> に変換（モックアップの部分強調を忠実に再現）。
// 正典 Astro 版の parse() と同じ規則: `**` で split し、奇数インデックスを bold に。
export function renderEmphasis(text: string): ReactNode {
  return text.split("**").map((seg, i) =>
    i % 2 === 1 ? <strong key={i}>{seg}</strong> : <Fragment key={i}>{seg}</Fragment>,
  );
}
