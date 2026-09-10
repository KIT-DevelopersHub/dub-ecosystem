// LP管理 — 北陸ITカンファレンス LP のバージョン一覧・閲覧（admin 想定 / app:lp:view ゲート）。
//
// バージョン定義はデータ駆動（lpVersions.ts の LP_VERSIONS）。この画面は取得点
// listLpVersions() を useQuery で読み、読み込み中はスケルトン、0 件なら空状態、失敗時は
// ErrorState を出す（Dub 既存アプリ = driveshare/usage と同じ状態ハンドリング）。各行から
// 公開 URL を新規タブで開ける（外部リンクは rel でハードニング）。
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import type { BadgeTone } from "@dub/ui";
import { listLpVersions, type LpVersion, type LpVersionStatus } from "./lpVersions.ts";

const LP_VERSIONS_KEY = ["lp", "versions"] as const;

const STATUS_META: Record<LpVersionStatus, { label: string; tone: BadgeTone }> = {
  current: { label: "現行", tone: "success" },
  draft: { label: "準備中", tone: "warning" },
  archived: { label: "旧版", tone: "neutral" },
};

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("ja-JP");
}

function VersionRow({ version }: { version: LpVersion }): JSX.Element {
  const status = STATUS_META[version.status];
  return (
    <Card testId={`fe2-lp-version-${version.id}`}>
      <Stack direction="row" gap={4} align="center" justify="between" wrap>
        <Stack gap={2}>
          <Stack direction="row" gap={3} align="center" wrap>
            <Icon name="megaphone" />
            <strong style={{ fontWeight: 700 }}>{version.name}</strong>
            <Badge tone={status.tone} testId={`fe2-lp-status-${version.id}`}>
              {status.label}
            </Badge>
          </Stack>
          <span style={{ opacity: 0.85 }}>{version.description}</span>
          <small style={{ opacity: 0.65 }}>更新日: {formatUpdated(version.updatedAt)}</small>
        </Stack>
        <a
          href={version.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${version.name} を新しいタブで見る`}
          style={{ textDecoration: "none" }}
          data-testid={`fe2-lp-view-${version.id}`}
        >
          <Button variant="secondary" iconRight={<Icon name="external-link" />}>
            見る
          </Button>
        </a>
      </Stack>
    </Card>
  );
}

export function LpManagementScreen(): JSX.Element {
  const query = useQuery({ queryKey: LP_VERSIONS_KEY, queryFn: listLpVersions });

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
      <Stack gap={4} testId="fe2-lp-loading">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <SkeletonLoader lines={3} />
          </Card>
        ))}
      </Stack>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        testId="fe2-lp-error"
        error={{ code: "INTERNAL", message: "LP バージョンを読み込めませんでした。" }}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!query.data || query.data.length === 0) {
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
      <Stack gap={4} testId="fe2-lp-list">
        {query.data.map((v) => (
          <VersionRow key={v.id} version={v} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-screen">
      {header}
      {body}
    </Stack>
  );
}
