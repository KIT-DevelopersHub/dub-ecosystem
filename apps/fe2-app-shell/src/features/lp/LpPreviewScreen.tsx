// 旧「プレビュー」タブ（/lp/preview）。公開設定の「プレビュー（下書き）」に統合したので、
// 古いブックマーク・リンクは /lp?env=draft へ置き換えで送る。
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SkeletonCard } from "@dub/ui";

export function LpPreviewScreen(): JSX.Element {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/lp", search: { env: "draft" }, replace: true });
  }, [navigate]);
  return <SkeletonCard lines={3} testId="fe2-lp-preview-redirect" />;
}
