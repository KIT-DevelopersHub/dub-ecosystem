// LP管理 — 「プレビュー」タブ。版とチケット販売あり/なしを選んで、その組み合わせの LP を開く。
//
// 設計メモ:
//  - 何も保存しない。選んだ条件は URL（?version=<番号>&tickets=on|off）に載り、LP Worker が
//    その閲覧者にだけ当てる。公開中の LP・販売状態・公開中の版は一切変わらない。
//  - チケット「あり」は販売停止中でも販売中の見た目にするだけで、申し込みは LP Worker が 403 で拒否する。
//  - 選べるのは LP Worker に同梱された版（公開フラグの versions）だけ。それ以外は別 URL の版なので
//    チケットを差し込めず、選択肢には出すが選べない。
//  - 見るだけなので app:lp:view で使える（公開の操作は「バージョン」「チケット」タブ）。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  FormField,
  Icon,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonLoader,
  Stack,
} from "@dub/ui";
import { listLpVersions, type LpVersion } from "./lpVersions.ts";
import { useLpPublish } from "./lpHooks.ts";
import { useLpTickets } from "./lpTicketsHooks.ts";
import { lpPreviewUrl } from "./lpPublish.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

type TicketsMode = "on" | "off";

const TICKETS_OPTIONS = [
  { value: "on" as const, label: "あり", testId: "fe2-lp-preview-tickets-on" },
  { value: "off" as const, label: "なし", testId: "fe2-lp-preview-tickets-off" },
];

export function LpPreviewScreen(): JSX.Element {
  const versionsQuery = useQuery({ queryKey: ["lp", "versions"], queryFn: listLpVersions });
  const publishQuery = useLpPublish();
  const tickets = useLpTickets();
  const publish = publishQuery.data;

  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<TicketsMode>("on");
  const [viewing, setViewing] = useState<LpVersion | null>(null);

  const versionId = picked ?? publish?.versionId ?? null;
  const options = useMemo(
    () =>
      (versionsQuery.data ?? []).map((v) => {
        const supported = !!publish?.versions.includes(v.id);
        const live = v.id === publish?.versionId;
        return {
          value: v.id,
          label: `${v.name}${live ? "（公開中）" : ""}${supported ? "" : "（プレビュー非対応）"}`,
          disabled: !supported,
        };
      }),
    [versionsQuery.data, publish],
  );
  const version = versionsQuery.data?.find((v) => v.id === versionId) ?? null;

  const header = (
    <PageHeader
      testId="fe2-lp-header"
      title="LP管理"
      description="北陸ITカンファレンスのランディングページ（LP）のバージョンを一覧・閲覧します。"
    />
  );

  let body: JSX.Element;
  if (versionsQuery.isLoading || publishQuery.isLoading) {
    body = (
      <Card testId="fe2-lp-preview-loading">
        <SkeletonLoader lines={5} />
      </Card>
    );
  } else if (versionsQuery.isError || publishQuery.isError || !publish) {
    body = (
      <ErrorState
        testId="fe2-lp-preview-error"
        error={{ code: "INTERNAL", message: "プレビューできる版を読み込めませんでした。" }}
        onRetry={() => {
          void versionsQuery.refetch();
          void publishQuery.refetch();
        }}
      />
    );
  } else {
    const sales = tickets.data ? (tickets.data.enabled ? "公開中" : "停止中") : null;
    const open = (): void => {
      if (!version) return;
      const label = mode === "on" ? "チケット販売あり" : "チケット販売なし";
      setViewing({ ...version, name: `${version.name}（${label}・プレビュー）`, url: lpPreviewUrl(version.id, mode) });
    };
    body = (
      <Card
        testId="fe2-lp-preview-settings"
        header={<span className={styles.sectionTitle}>プレビューの設定</span>}
        footer={
          <div className={styles.previewFooter}>
            <Button
              variant="primary"
              iconRight={<Icon name="external-link" />}
              disabled={!version}
              onClick={open}
              testId="fe2-lp-preview-open"
            >
              プレビューを開く
            </Button>
          </div>
        }
      >
        <Stack gap={6}>
          <FormField
            label="バージョン"
            htmlFor="fe2-lp-preview-version"
            help="公開中ではない版も、公開せずに見られます。"
          >
            <Select
              id="fe2-lp-preview-version"
              testId="fe2-lp-preview-version"
              value={versionId}
              onChange={setPicked}
              options={options}
            />
          </FormField>
          <Stack gap={2}>
            <div className={styles.statusRow}>
              <SegmentedControl<TicketsMode>
                caption="チケット販売"
                aria-label="チケット販売"
                value={mode}
                onChange={setMode}
                options={TICKETS_OPTIONS}
                testId="fe2-lp-preview-tickets"
              />
              {sales ? (
                <Badge tone={tickets.data?.enabled ? "success" : "neutral"} testId="fe2-lp-preview-sales-state">
                  実際の販売: {sales}
                </Badge>
              ) : null}
            </div>
            <span className={styles.note}>
              {mode === "on"
                ? "販売を停止していても、購入ボタンとチケット購入ページが出た状態で開きます。プレビュー中はお申し込みできません。券種などの設定は「チケット」タブで行います。"
                : "販売を公開していても、チケットの表示が無い状態で開きます。"}
            </span>
          </Stack>
          <p className={styles.previewNotice} data-testid="fe2-lp-preview-notice">
            <Icon name="info" />
            <span>
              これは確認用のプレビューです。開いたあなたの画面にだけ効き、公開中の LP・公開中の版・チケットの販売状態は変わりません。
            </span>
          </p>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-preview-screen">
      {header}
      <LpTabs active="preview" />
      {body}
      {viewing ? <LpViewer version={viewing} onBack={() => setViewing(null)} /> : null}
    </Stack>
  );
}
