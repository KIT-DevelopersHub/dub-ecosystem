// LP管理 — LP を「アプリ内フルスクリーン」で閲覧するビューア。
//
// 以前は各バージョンの「見る」が target="_blank" で LP を別ブラウザタブに開いていた
// （ユーザーがタブを閉じて管理画面に戻る手間があった）。本コンポーネントは LP を Dub
// アプリの中にフルスクリーンで表示する:
//   • document.body への portal で描画し position:fixed inset:0 でシェルの
//     ヘッダー/9ドットランチャー(=ナビ)ごと覆う → LP 表示中は「タブ(ナビ)が消える」。
//   • 上部ツールバーに「アプリに戻る」ボタンを置き、押すと onBack で通常 UI(=元の
//     LP管理画面・ランチャーの導線)に復帰する。別ブラウザタブは開かない。
//   • iframe で埋め込めない LP(X-Frame-Options 等)でも行き止まりにしないよう
//     「新しいタブで開く」フォールバック導線を右側に残す。
// バックエンド依存はなく、LP の URL は lpVersions.ts の静的カタログ由来。
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button, Icon } from "@dub/ui";
import { toCssVarName } from "@dub/tokens";
import type { LpVersion } from "./lpVersions.ts";

export interface LpViewerProps {
  /** 表示中の LP バージョン。 */
  version: LpVersion;
  /** 「アプリに戻る」= ビューアを閉じて通常 UI へ復帰。 */
  onBack: () => void;
}

const surface = (path: string): string => toCssVarName(path);

/**
 * LP を Dub アプリ内でフルスクリーン表示するビューア。シェルの全 chrome を覆うため
 * document.body に portal し、Escape でも戻れる。開いている間は背後のスクロールを止める。
 */
export function LpViewer({ version, onBack }: LpViewerProps): JSX.Element {
  // Escape で戻る + 開いている間は背後(body)のスクロールをロック。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onBack]);

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${version.name} をプレビュー`}
      data-testid="fe2-lp-viewer"
      style={{
        position: "fixed",
        inset: 0,
        // シェルのヘッダー(=ナビ/9ドットランチャー)より前面に出して覆い隠す。
        zIndex: 2147483000,
        display: "flex",
        flexDirection: "column",
        background: surface("color.surface.base"),
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: surface("space.4"),
          padding: `${surface("space.3")} ${surface("space.4")}`,
          borderBottom: `1px solid ${surface("color.border.default")}`,
          background: surface("color.surface.raised"),
        }}
      >
        <Button
          variant="secondary"
          iconLeft={<Icon name="home" />}
          onClick={onBack}
          testId="fe2-lp-back-button"
        >
          アプリに戻る
        </Button>
        <span
          style={{
            fontWeight: 700,
            color: surface("color.text.primary"),
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={version.name}
        >
          {version.name}
        </span>
        <a
          href={version.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${version.name} を新しいタブで開く`}
          style={{ textDecoration: "none", flex: "0 0 auto" }}
          data-testid={`fe2-lp-open-new-tab-${version.id}`}
        >
          <Button variant="ghost" iconRight={<Icon name="external-link" />}>
            新しいタブで開く
          </Button>
        </a>
      </div>
      <iframe
        src={version.url}
        title={version.name}
        data-testid="fe2-lp-viewer-frame"
        style={{ flex: "1 1 auto", width: "100%", height: "100%", border: "none" }}
      />
    </div>
  );

  return createPortal(overlay, document.body);
}
