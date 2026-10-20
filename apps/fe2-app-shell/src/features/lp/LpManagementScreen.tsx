// LP管理 — 北陸ITカンファレンス LP のバージョン一覧・閲覧（admin 想定 / app:lp:view ゲート）。
//
// バージョン定義はデータ駆動（lpVersions.ts の LP_VERSIONS）。この画面は取得点
// listLpVersions() を useQuery で読み、読み込み中はスケルトン、0 件なら空状態、失敗時は
// ErrorState を出す（Dub 既存アプリ = driveshare/usage と同じ状態ハンドリング）。各行から
// 公開 URL を新規タブで開ける（外部リンクは rel でハードニング）。
//
// 「公開中」バッジはサーバーの公開フラグ（GET /api/v1/lp/publish）が正で、lpVersions.ts の
// status ではない。公開する版の切り替えは「本番公開」タブに集約したので、ここは状態の表示と
// そのタブへの導線だけを持つ。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  Skeleton,
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import { listLpVersions, type LpVersion } from "./lpVersions.ts";
import type { LpPublishState } from "./lpApi.tsx";
import { useLpPublish } from "./lpHooks.ts";
import { formatSwitchedAt, lpViewUrl } from "./lpPublish.ts";
import { LpViewer } from "./LpViewer.tsx";
import { GotoPublishButton, LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

const LP_VERSIONS_KEY = ["lp", "versions"] as const;

/** 一覧のバッジ。公開中はサーバーの公開フラグで決まり、それ以外は準備中/非公開。 */
function badgeFor(version: LpVersion, publishedId: string | undefined): { label: string; tone: BadgeTone } {
  if (version.id === publishedId) return { label: "公開中", tone: "success" };
  if (version.status === "draft") return { label: "準備中", tone: "warning" };
  return { label: "非公開", tone: "neutral" };
}

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("ja-JP");
}

// 1 版 = 1 行。説明文は畳んでおき「詳細」で開く（版が増えても一覧を一目で見渡せるように）。
// 列は grid で固定しているので、説明の長さに関係なく全行のボタンが同じ位置に揃う。
function VersionRow({
  version,
  publish,
  publishLoading,
  onView,
}: {
  version: LpVersion;
  publish: LpPublishState | undefined;
  publishLoading: boolean;
  onView: (version: LpVersion) => void;
}): JSX.Element {
  const status = badgeFor(version, publish?.versionId);
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.versionRow} data-testid={`fe2-lp-version-${version.id}`}>
      <div className={styles.versionLine}>
        <Icon name="megaphone" />
        <strong className={styles.versionName}>{version.name}</strong>
        {publishLoading ? (
          <span className={styles.versionBadgeSkeleton} role="status" aria-label="公開状態を読み込み中">
            <Skeleton width={56} height={20} testId={`fe2-lp-status-loading-${version.id}`} />
          </span>
        ) : (
          <Badge tone={status.tone} testId={`fe2-lp-status-${version.id}`}>
            {status.label}
          </Badge>
        )}
        <small className={styles.versionDate}>{formatUpdated(version.updatedAt)}</small>
        <Button
          variant="ghost"
          size="sm"
          iconRight={<Icon name={open ? "chevron-down" : "chevron-right"} />}
          onClick={() => setOpen((v) => !v)}
          testId={`fe2-lp-details-toggle-${version.id}`}
        >
          詳細
        </Button>
        {/* 「見る」= アプリ内フルスクリーンで LP を表示（別ブラウザタブは開かない）。
            LP 表示中はシェルの chrome を覆って隠し、「アプリに戻る」で通常 UI へ戻る。 */}
        <Button
          variant="secondary"
          size="sm"
          iconRight={<Icon name="external-link" />}
          onClick={() => onView(version)}
          testId={`fe2-lp-view-${version.id}`}
        >
          見る
        </Button>
      </div>
      {open ? (
        <div className={styles.versionDetails} data-testid={`fe2-lp-details-${version.id}`}>
          <p className={styles.note}>{version.description}</p>
          {version.prUrl ? (
            <a className={styles.urlOpen} href={version.prUrl} target="_blank" rel="noopener noreferrer">
              変更の PR を開く
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LpManagementScreen(): JSX.Element {
  const query = useQuery({ queryKey: LP_VERSIONS_KEY, queryFn: listLpVersions });
  // 表示中の LP（null = 一覧表示）。「見る」でセットしてフルスクリーン閲覧に入り、
  // 「アプリに戻る」で null に戻して通常の管理画面(=アプリ)へ復帰する。
  const [viewing, setViewing] = useState<LpVersion | null>(null);

  const publishQuery = useLpPublish();
  const publish = publishQuery.data;

  // 「見る」の行き先は公開フラグ次第（公開対象の版 = 公開サイトのプレビュー URL）。
  const versions = useMemo(
    () => query.data?.map((v) => ({ ...v, url: lpViewUrl(v.id, v.url, publish) })),
    [query.data, publish],
  );
  const nameOf = (id: string): string => query.data?.find((v) => v.id === id)?.name ?? id;

  const header = (
    <PageHeader
      testId="fe2-lp-header"
      title="LP管理"
      description="北陸ITカンファレンスのランディングページ（LP）のバージョンを一覧・閲覧します。"
    />
  );

  let body: JSX.Element;
  if (query.isLoading) {
    body = (
      <Card testId="fe2-lp-loading">
        <SkeletonLoader lines={6} />
      </Card>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        testId="fe2-lp-error"
        error={{ code: "INTERNAL", message: "LP バージョンを読み込めませんでした。" }}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!versions || versions.length === 0) {
    body = (
      <EmptyState
        testId="fe2-lp-empty"
        icon="megaphone"
        title="LP バージョンがありません"
        description="LP のバージョンが登録されるとここに一覧表示されます。"
      />
    );
  } else {
    body = (
      <Stack gap={3}>
        <PublishSummary
          publish={publish}
          loading={publishQuery.isLoading}
          error={publishQuery.isError}
          nameOf={nameOf}
          onRetry={() => void publishQuery.refetch()}
        />
        <Card padded={false} testId="fe2-lp-list">
          {versions.map((v) => (
            <VersionRow
              key={v.id}
              version={v}
              publish={publish}
              publishLoading={publishQuery.isLoading}
              onView={setViewing}
            />
          ))}
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-screen">
      {header}
      {/* バージョン ⇄ ログ管理。タブは URL に紐づく（/lp・/lp/visits）。 */}
      <LpTabs active="versions" />
      {body}
      {viewing ? <LpViewer version={viewing} onBack={() => setViewing(null)} /> : null}
    </Stack>
  );
}

/** 一覧上部の 1 行サマリ「公開中: v3.4（… に … が切り替え）」。 */
function PublishSummary({
  publish,
  loading,
  error,
  nameOf,
  onRetry,
}: {
  publish: LpPublishState | undefined;
  loading: boolean;
  error: boolean;
  nameOf: (id: string) => string;
  onRetry: () => void;
}): JSX.Element | null {
  if (loading) {
    return (
      <div className={styles.publishSummary} role="status" aria-label="公開状態を読み込み中">
        <Skeleton width={280} height={18} testId="fe2-lp-publish-summary-loading" />
      </div>
    );
  }
  if (error || !publish) {
    return (
      <div className={styles.publishSummary} data-testid="fe2-lp-publish-error">
        <span>公開中の版を読み込めませんでした。</span>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          再読み込み
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.publishSummary} data-testid="fe2-lp-publish-summary">
      <Icon name="flag" />
      <span>
        <strong>公開中: {nameOf(publish.versionId)}</strong>
        {publish.updatedAt ? `（${formatSwitchedAt(publish.updatedAt)} に切り替え）` : null}
      </span>
      <GotoPublishButton testId="fe2-lp-versions-goto-publish" />
    </div>
  );
}
