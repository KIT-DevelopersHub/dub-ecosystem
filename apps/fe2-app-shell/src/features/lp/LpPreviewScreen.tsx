// LP管理 — 「プレビュー」タブ。版・チケット販売あり/なし・登壇者募集あり/なしを選んで、その組み合わせの LP を開く。
//
// 設計メモ:
//  - 何も保存しない。選んだ条件は URL（?version=<番号>&tickets=on|off&proposals=on|off）に載り、LP Worker が
//    その閲覧者にだけ当てる。公開中の LP・販売状態・公開中の版は一切変わらない。
//  - チケット「あり」は販売停止中でも販売中の見た目にするだけで、申し込みは LP Worker が 403 で拒否する。
//    ただし Stripe がテストキーの時（previewCheckout）は、開く時にテスト購入トークン（app:lp:edit・1 時間）を
//    発行して URL に載せ、この閲覧者だけテスト購入（実際の請求なし・LP管理で「テスト」表示）まで試せる。
//    トークンを発行できない（view 権限・本番キー）時は従来どおり見た目だけで開く。
//    登壇者募集「あり」も同じ（「登壇に応募する」ボタンと /proposals が出るが、応募は 403）。
//  - 選べるのは LP Worker に同梱された版（公開フラグの versions）だけ。それ以外は別 URL の版なので
//    チケットを差し込めず、選択肢には出すが選べない。
//  - 見るだけなので app:lp:view で使える（公開の操作は「バージョン」「チケット」タブ）。
//  - 開くと /lp/preview?open=1 を履歴に積む。ブラウザの「戻る」はビューアを閉じてこのタブに留まる
//    （積まないと、前に居たタブ＝チケット等へ戻ってしまう）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
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
import { useLpApi } from "./LpProvider.tsx";
import { useLpProposals } from "./lpProposalsHooks.ts";
import { lpPreviewUrl, type LpPreviewMode } from "./lpPublish.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

const TICKETS_OPTIONS = [
  { value: "on" as const, label: "あり", testId: "fe2-lp-preview-tickets-on" },
  { value: "off" as const, label: "なし", testId: "fe2-lp-preview-tickets-off" },
];

const PROPOSALS_OPTIONS = [
  { value: "on" as const, label: "あり", testId: "fe2-lp-preview-proposals-on" },
  { value: "off" as const, label: "なし", testId: "fe2-lp-preview-proposals-off" },
];

export function LpPreviewScreen(): JSX.Element {
  const versionsQuery = useQuery({ queryKey: ["lp", "versions"], queryFn: listLpVersions });
  const publishQuery = useLpPublish();
  const tickets = useLpTickets();
  const lpApi = useLpApi();
  const [opening, setOpening] = useState(false);
  const proposals = useLpProposals();
  const publish = publishQuery.data;

  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<LpPreviewMode>("on");
  const [proposalsMode, setProposalsMode] = useState<LpPreviewMode>("on");
  const [viewing, setViewing] = useState<LpVersion | null>(null);

  const navigate = useNavigate();
  const router = useRouter();
  const openInUrl = useRouterState({
    select: (st) => new URLSearchParams(st.location.searchStr ?? "").has("open"),
  });
  // ブラウザの「戻る」で ?open が外れたらビューアを閉じる。
  const wasOpenInUrl = useRef(openInUrl);
  useEffect(() => {
    if (wasOpenInUrl.current && !openInUrl) setViewing(null);
    wasOpenInUrl.current = openInUrl;
  }, [openInUrl]);

  const close = ({ frameNavigated }: { frameNavigated: boolean }): void => {
    setViewing(null);
    if (!openInUrl) return;
    // LP 内で移動していなければ積んだ 1 件を戻す。移動していると履歴が何件積まれたか
    // 分からないので、戻り過ぎて別タブへ出ないよう置き換えで閉じる。
    if (!frameNavigated && router) router.history.back();
    else void navigate({ to: "/lp/preview", replace: true });
  };

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
    const call = proposals.data ? (proposals.data.enabled ? "募集中" : "停止中") : null;
    const testPurchase = mode === "on" && tickets.data?.enabled === false && tickets.data.previewCheckout === true;
    const open = async (): Promise<void> => {
      if (!version) return;
      let previewToken: string | undefined;
      if (testPurchase) {
        setOpening(true);
        try {
          previewToken = (await lpApi.createTicketPreviewToken()).token;
        } catch {
          // view 権限 / 本番キーに切り替わった等: 見た目だけのプレビューで開く。
        } finally {
          setOpening(false);
        }
      }
      const label = `${mode === "on" ? (previewToken ? "チケット販売あり（テスト購入可）" : "チケット販売あり") : "チケット販売なし"}・${proposalsMode === "on" ? "登壇者募集あり" : "登壇者募集なし"}`;
      setViewing({
        ...version,
        name: `${version.name}（${label}・プレビュー）`,
        url: lpPreviewUrl(version.id, { tickets: mode, proposals: proposalsMode, previewToken }),
      });
      void navigate({ to: "/lp/preview", search: { open: 1 } });
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
              disabled={!version || opening}
              onClick={() => void open()}
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
            <div className={styles.previewTicketsRow}>
              <SegmentedControl<LpPreviewMode>
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
              {mode === "on" && tickets.data?.enabled
                ? "販売を公開中のため、実際の購入ページがそのまま開きます（申し込むと本物の購入になります）。"
                : testPurchase
                ? "販売を停止していても、購入ページからテスト購入まで試せます（Stripe のテスト環境・実際の請求なし・1 時間有効）。テスト注文は「チケット」タブの購入者に「テスト」と表示されます。"
                : mode === "on"
                ? "販売を停止していても、購入ボタンとチケット購入ページが出た状態で開きます。プレビュー中はお申し込みできません。券種などの設定は「チケット」タブで行います。"
                : "販売を公開していても、チケットの表示が無い状態で開きます。"}
            </span>
          </Stack>
          <Stack gap={2}>
            <div className={styles.previewTicketsRow}>
              <SegmentedControl<LpPreviewMode>
                caption="登壇者募集"
                aria-label="登壇者募集"
                value={proposalsMode}
                onChange={setProposalsMode}
                options={PROPOSALS_OPTIONS}
                testId="fe2-lp-preview-proposals"
              />
              {call ? (
                <Badge tone={proposals.data?.enabled ? "success" : "neutral"} testId="fe2-lp-preview-proposals-state">
                  実際の募集: {call}
                </Badge>
              ) : null}
            </div>
            <span className={styles.note} data-testid="fe2-lp-preview-proposals-note">
              {proposalsMode === "on"
                ? proposals.data?.enabled
                  ? "募集を公開中のため、実際の応募ページがそのまま開きます（送信すると本物の応募として届きます）。"
                  : "募集を停止していても、「登壇に応募する」ボタンが押せて応募ページが出た状態で開きます。プレビュー中は応募できません。入力項目は「登壇者募集」タブで設定します。"
                : "募集を公開していても、「登壇に応募する」ボタンが「準備中」のままの状態で開きます。"}
            </span>
          </Stack>
          <p className={styles.previewNotice} data-testid="fe2-lp-preview-notice">
            <Icon name="info" />
            <span>
              これは確認用のプレビューです。開いたあなたの画面にだけ効き、公開中の LP・公開中の版・チケットの販売状態・登壇者の募集状態は変わりません。
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
      {viewing ? <LpViewer version={viewing} onBack={close} /> : null}
    </Stack>
  );
}
