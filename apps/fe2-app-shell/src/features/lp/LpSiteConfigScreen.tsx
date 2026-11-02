// LP管理 — 「公開設定」タブ（/lp）。旧「バージョン」「プレビュー」タブを統合した画面。
//
// 上部の切り替え（URL の ?env=draft|live）で「プレビュー（下書き）」と「本番」を描き分けるが、カードは共通:
//   本番反映（公開する版・チケット販売・参加登録ボタン差し替え・登壇者募集）/ 各セクション（ヘッダー含む）。
// セクションのカードは登録簿（LP_SECTION_REGISTRY）から汎用に描くので、バリアント・オプションを足すと自動で出る。
//  - 下書き: 変えるたびに自動保存（楽観的・失敗で戻す・409 は読み直し）。確認ダイアログは出さない。
//    「プレビューを開く」は下書きの値で LP を開く（&config=draft）。「この下書きを本番へ反映」は本番と同じ確認を通す。
//  - 本番: 変更は画面に溜めて「変更 N 件」と差分を出し、「本番に反映」→ 確認ダイアログでまとめて 1 回で反映する。
//    チケット販売を公開にする変更を含むときは ack チェックを必須にする。lp:publish が無ければ操作は無効。
import { useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lp } from "@dub/types";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Icon,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonCard,
  Stack,
  Switch,
} from "@dub/ui";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import { AppReadOnlyNotice } from "../../auth/AppReadOnlyNotice.tsx";
import type { LpSiteConfig } from "./lpApi.tsx";
import { useLpApi } from "./LpProvider.tsx";
import { useLpTickets } from "./lpTicketsHooks.ts";
import {
  diffSiteConfig,
  draftPreviewUrl,
  enablesTickets,
  parseEnv,
  RELEASE_FLAGS,
  setRelease,
  setSection,
  versionName,
  type ConfigDiff,
  type LpConfigEnv,
} from "./lpSiteConfig.ts";
import { useDraftAutosave, useLpSiteConfig, usePublishSiteConfig, useResetDraft } from "./lpSiteConfigHooks.ts";
import { formatSwitchedAt, lpViewUrl } from "./lpPublish.ts";
import { LP_VERSIONS, type LpVersion } from "./lpVersions.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

const ENV_OPTIONS = [
  { value: "draft" as const, label: "プレビュー（下書き）", testId: "fe2-lp-config-env-draft" },
  { value: "live" as const, label: "本番", testId: "fe2-lp-config-env-live" },
];

export const PUBLISH_CONFIRM_TITLE = "これは本番です。反映してよいですか？";

export function LpSiteConfigScreen(): JSX.Element {
  const navigate = useNavigate();
  const env = useRouterState({ select: (st) => parseEnv(st.location.searchStr) });
  const query = useLpSiteConfig();
  const tickets = useLpTickets();
  const lpApi = useLpApi();
  const autosave = useDraftAutosave();
  const reset = useResetDraft();
  const publish = usePublishSiteConfig();
  const { canEdit } = useAppCapability("lp");
  const { can } = usePermissions();
  const canPublish = canEdit && can("lp:publish");

  const [staged, setStaged] = useState<LpSiteConfig | null>(null);
  const [confirm, setConfirm] = useState<{ from: LpSiteConfig; to: LpSiteConfig; source: LpConfigEnv } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [viewing, setViewing] = useState<LpVersion | null>(null);
  const [opening, setOpening] = useState(false);

  const state = query.data;
  const live = env === "live";
  const config = state ? (live ? (staged ?? state.published) : state.draft) : null;
  const stagedDiff = useMemo(() => (state && staged ? diffSiteConfig(state.published, staged) : []), [state, staged]);
  const draftDiff = useMemo(() => (state ? diffSiteConfig(state.published, state.draft) : []), [state]);
  const canChange = live ? canPublish && !publish.isPending : canEdit;

  const switchEnv = (next: LpConfigEnv): void => {
    if (next !== env) void navigate({ to: "/lp", search: { env: next }, replace: true });
  };

  const onChange = (next: LpSiteConfig): void => {
    if (!state || !canChange) return;
    if (live) setStaged(diffSiteConfig(state.published, next).length > 0 ? next : null);
    else autosave.save(next);
  };

  const doPublish = (): void => {
    if (!confirm) return;
    const { to, source } = confirm;
    const restore = source === "live" ? staged : null;
    setConfirm(null);
    if (source === "live") setStaged(null);
    publish.mutate({ config: to }, { onError: () => restore && setStaged(restore) });
  };

  const openPreview = async (): Promise<void> => {
    if (!state) return;
    const draft = state.draft;
    let token: string | undefined;
    if (draft.release.ticketsEnabled && !state.published.release.ticketsEnabled && tickets.data?.previewCheckout) {
      setOpening(true);
      try {
        token = (await lpApi.createTicketPreviewToken()).token;
      } catch {
        // view 権限・本番キー等: 見た目だけのプレビューで開く。
      } finally {
        setOpening(false);
      }
    }
    const base = LP_VERSIONS.find((v) => v.id === draft.release.versionId) ?? LP_VERSIONS[0]!;
    setViewing({ ...base, name: `${versionName(draft.release.versionId)}（下書きのプレビュー）`, url: draftPreviewUrl(draft, token) });
  };

  let body: JSX.Element;
  if (query.isLoading) {
    body = (
      <Stack gap={6} testId="fe2-lp-config-loading">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </Stack>
    );
  } else if (query.isError || !state || !config) {
    body = (
      <ErrorState
        testId="fe2-lp-config-error"
        error={{ code: "INTERNAL", message: "公開設定を読み込めませんでした。" }}
        onRetry={() => void query.refetch()}
      />
    );
  } else {
    body = (
      <Stack gap={6}>
        {live ? (
          <p className={styles.liveBanner} data-testid="fe2-lp-config-live-banner">
            <Icon name="flag" />
            <span>
              本番の設定です。変更は「本番に反映」を押して確認するまで公開されません。
              {!canPublish ? " 変更には lp:publish 権限が必要です。" : ""}
            </span>
          </p>
        ) : (
          <p className={styles.previewNotice} data-testid="fe2-lp-config-draft-notice">
            <Icon name="info" />
            <span>下書きは変えるたびに自動で保存されます。公開中の LP は「この下書きを本番へ反映」まで変わりません。</span>
          </p>
        )}
        <ReleaseCard
          config={config}
          publishedVersionId={state.published.release.versionId}
          disabled={!canChange}
          onChange={onChange}
          onOpenCatalog={() => setCatalogOpen(true)}
        />
        {lp.LP_SECTION_IDS.map((id) => (
          <SectionCard key={id} id={id} config={config} disabled={!canChange} onChange={onChange} />
        ))}
        {live ? (
          <Card testId="fe2-lp-config-live-actions">
            <Stack gap={4}>
              <div className={styles.actionBar}>
                <Badge tone={stagedDiff.length > 0 ? "warning" : "neutral"} testId="fe2-lp-config-change-count">
                  変更 {stagedDiff.length} 件
                </Badge>
                <span className={styles.actionSpacer} />
                <Button
                  variant="secondary"
                  disabled={stagedDiff.length === 0}
                  onClick={() => setStaged(null)}
                  testId="fe2-lp-config-discard"
                >
                  取り消す
                </Button>
                <Button
                  variant="primary"
                  disabled={!canPublish || stagedDiff.length === 0 || publish.isPending}
                  onClick={() => staged && setConfirm({ from: state.published, to: staged, source: "live" })}
                  testId="fe2-lp-config-publish"
                >
                  本番に反映…
                </Button>
              </div>
              {stagedDiff.length > 0 ? <DiffList diff={stagedDiff} testId="fe2-lp-config-staged-diff" /> : null}
            </Stack>
          </Card>
        ) : (
          <Card testId="fe2-lp-config-draft-actions">
            <div className={styles.actionBar}>
              <Button
                variant="primary"
                iconRight={<Icon name="external-link" />}
                disabled={opening}
                onClick={() => void openPreview()}
                testId="fe2-lp-config-preview-open"
              >
                プレビューを開く
              </Button>
              <span className={styles.actionSpacer} />
              <Button
                variant="secondary"
                disabled={!canEdit || draftDiff.length === 0 || reset.isPending}
                onClick={() => setResetting(true)}
                testId="fe2-lp-config-reset"
              >
                本番の内容に戻す
              </Button>
              <Button
                variant="secondary"
                disabled={!canPublish || draftDiff.length === 0 || publish.isPending}
                onClick={() => setConfirm({ from: state.published, to: state.draft, source: "draft" })}
                testId="fe2-lp-config-publish-draft"
              >
                この下書きを本番へ反映…
              </Button>
            </div>
          </Card>
        )}
      </Stack>
    );
  }

  const status = state
    ? live
      ? state.publishedAt
        ? `本番: ${formatSwitchedAt(state.publishedAt)} に反映`
        : null
      : autosave.saving
        ? "保存中…"
        : state.draftUpdatedAt
          ? `下書き: ${formatSwitchedAt(state.draftUpdatedAt)} に保存`
          : null
    : null;

  return (
    <Stack gap={6} testId="fe2-lp-config-screen">
      <PageHeader
        testId="fe2-lp-header"
        title="LP管理"
        description="北陸ITカンファレンスのランディングページ（LP）の見た目と公開状態を、下書きで確かめてから本番に反映します。"
      />
      <LpTabs active="config" />
      <AppReadOnlyNotice appId="lp" />
      <div className={styles.configToolbar}>
        <SegmentedControl<LpConfigEnv>
          aria-label="環境"
          value={env}
          onChange={switchEnv}
          options={ENV_OPTIONS.map((o) =>
            o.value === "live" && staged ? { ...o, label: `本番（未反映 ${stagedDiff.length}）` } : o,
          )}
          testId="fe2-lp-config-env"
        />
        {status ? (
          <span className={styles.note} data-testid="fe2-lp-config-status">
            {status}
          </span>
        ) : null}
      </div>
      {body}
      {confirm ? (
        <PublishConfirm
          diff={diffSiteConfig(confirm.from, confirm.to)}
          needsAck={enablesTickets(confirm.from, confirm.to)}
          onConfirm={doPublish}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      <ConfirmDialog
        open={resetting}
        title="下書きを本番の内容に戻します"
        message="下書きで変えた内容は消えます。公開中の LP は変わりません。"
        confirmLabel="戻す"
        testId="fe2-lp-config-reset-dialog"
        onConfirm={() => {
          setResetting(false);
          reset.mutate();
        }}
        onCancel={() => setResetting(false)}
      />
      {state ? (
        <VersionCatalog
          open={catalogOpen}
          publishedVersionId={state.published.release.versionId}
          onClose={() => setCatalogOpen(false)}
          onView={(v) => {
            setCatalogOpen(false);
            setViewing(v);
          }}
        />
      ) : null}
      {viewing ? <LpViewer version={viewing} onBack={() => setViewing(null)} /> : null}
    </Stack>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div className={styles.configRow}>
      <div className={styles.configRowLabel}>
        <span>{label}</span>
        {hint ? <span className={styles.note}>{hint}</span> : null}
      </div>
      <div className={styles.configRowControl}>{children}</div>
    </div>
  );
}

function ReleaseCard({
  config,
  publishedVersionId,
  disabled,
  onChange,
  onOpenCatalog,
}: {
  config: LpSiteConfig;
  publishedVersionId: string;
  disabled: boolean;
  onChange: (next: LpSiteConfig) => void;
  onOpenCatalog: () => void;
}): JSX.Element {
  const options = lp.LP_PUBLISHABLE_VERSION_IDS.map((id) => ({
    value: id as string,
    label: `${versionName(id)}${id === publishedVersionId ? "（公開中）" : ""}`,
  }));
  return (
    <Card testId="fe2-lp-config-release" header={<span className={styles.sectionTitle}>本番反映</span>}>
      <Stack gap={6}>
        <SettingRow label="公開する版">
          <div className={styles.statusRow}>
            <Select
              id="fe2-lp-config-version"
              testId="fe2-lp-config-version"
              value={config.release.versionId}
              disabled={disabled}
              onChange={(v) => onChange(setRelease(config, "versionId", v))}
              options={options}
            />
            <Button variant="ghost" size="sm" onClick={onOpenCatalog} testId="fe2-lp-config-catalog-open">
              版の一覧
            </Button>
          </div>
        </SettingRow>
        {RELEASE_FLAGS.map((f) => (
          <SettingRow
            key={f.key}
            label={f.label}
            hint={f.key === "ticketsCtaEnabled" ? "チケット販売が公開のときだけ効きます。" : undefined}
          >
            <div className={styles.statusRow}>
              <Switch
                id={`fe2-lp-config-${f.key}`}
                testId={`fe2-lp-config-${f.key}`}
                checked={config.release[f.key]}
                disabled={disabled}
                label={config.release[f.key] ? f.on : f.off}
                onChange={(v) => onChange(setRelease(config, f.key, v))}
              />
            </div>
          </SettingRow>
        ))}
      </Stack>
    </Card>
  );
}

function SectionCard({
  id,
  config,
  disabled,
  onChange,
}: {
  id: lp.LpSectionId;
  config: LpSiteConfig;
  disabled: boolean;
  onChange: (next: LpSiteConfig) => void;
}): JSX.Element {
  const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
  const cur = lp.resolveSection(config.layout, id);
  const variants = Object.entries(def.variants).map(([value, label]) => ({ value, label }));
  return (
    <Card testId={`fe2-lp-config-section-${id}`} header={<span className={styles.sectionTitle}>{def.label}</span>}>
      <Stack gap={6}>
        <SettingRow label="バリアント" hint={variants.length === 1 ? "いまは 1 種類だけです。" : undefined}>
          <Select
            id={`fe2-lp-config-${id}-variant`}
            testId={`fe2-lp-config-${id}-variant`}
            value={cur.variant}
            disabled={disabled || variants.length < 2}
            onChange={(v) => onChange(setSection(config, id, { variant: v }))}
            options={variants}
          />
        </SettingRow>
        <SettingRow label="表示" hint={def.hideable ? undefined : "このセクションは常に表示されます。"}>
          <Switch
            id={`fe2-lp-config-${id}-visible`}
            testId={`fe2-lp-config-${id}-visible`}
            checked={cur.visible}
            disabled={disabled || !def.hideable}
            label={cur.visible ? "表示" : "非表示"}
            onChange={(v) => onChange(setSection(config, id, { visible: v }))}
          />
        </SettingRow>
        {Object.entries(def.options ?? {}).map(([key, od]) => (
          <SettingRow key={key} label={od.label}>
            {od.kind === "boolean" ? (
              <Switch
                id={`fe2-lp-config-${id}-${key}`}
                testId={`fe2-lp-config-${id}-${key}`}
                checked={cur.options[key] === true}
                disabled={disabled}
                label={cur.options[key] === true ? "表示" : "非表示"}
                onChange={(v) => onChange(setSection(config, id, { option: { key, value: v } }))}
              />
            ) : (
              <Select
                id={`fe2-lp-config-${id}-${key}`}
                testId={`fe2-lp-config-${id}-${key}`}
                value={String(cur.options[key])}
                disabled={disabled}
                onChange={(v) => onChange(setSection(config, id, { option: { key, value: v } }))}
                options={Object.entries(od.values ?? {}).map(([value, label]) => ({ value, label }))}
              />
            )}
          </SettingRow>
        ))}
      </Stack>
    </Card>
  );
}

function DiffList({ diff, testId }: { diff: ConfigDiff[]; testId: string }): JSX.Element {
  return (
    <ul className={styles.diffList} data-testid={testId}>
      {diff.map((d) => (
        <li key={d.key} data-testid={`${testId}-${d.key}`}>
          <span className={styles.diffLabel}>{d.label}</span>
          <span className={styles.diffFrom}>{d.from}</span>
          <Icon name="chevron-right" />
          <strong>{d.to}</strong>
        </li>
      ))}
    </ul>
  );
}

function PublishConfirm({
  diff,
  needsAck,
  onConfirm,
  onCancel,
}: {
  diff: ConfigDiff[];
  needsAck: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [acked, setAcked] = useState(false);
  return (
    <ConfirmDialog
      open
      title={PUBLISH_CONFIRM_TITLE}
      testId="fe2-lp-config-publish-dialog"
      confirmLabel="本番に反映する"
      confirmDisabled={needsAck && !acked}
      onConfirm={onConfirm}
      onCancel={onCancel}
      message={
        <Stack gap={4}>
          <span>次の {diff.length} 件を hokuriku-it-conf.com にまとめて反映します。</span>
          <DiffList diff={diff} testId="fe2-lp-config-publish-diff" />
          {needsAck ? (
            <>
              <p className={styles.publishWarning} role="alert" data-testid="fe2-lp-config-tickets-warning">
                {"チケット販売を公開します。ログインしていない一般の方を含むインターネット上の誰でも、購入ページを開いて申し込めるようになります。"}
              </p>
              <Checkbox
                id="fe2-lp-config-tickets-ack"
                testId="fe2-lp-config-tickets-ack"
                checked={acked}
                label="全ユーザーに公開されることを理解しました"
                onChange={setAcked}
              />
            </>
          ) : null}
          <span className={styles.note}>ビルドやデプロイは行いません。反映まで最大 1 分ほどかかります。</span>
        </Stack>
      }
    />
  );
}

/** 旧「バージョン」タブの版の一覧（説明・PR・見る）。 */
function VersionCatalog({
  open,
  publishedVersionId,
  onClose,
  onView,
}: {
  open: boolean;
  publishedVersionId: string;
  onClose: () => void;
  onView: (v: LpVersion) => void;
}): JSX.Element {
  const publishState = { versionId: publishedVersionId, versions: lp.LP_PUBLISHABLE_VERSION_IDS };
  return (
    <Drawer open={open} onClose={onClose} title="版の一覧" testId="fe2-lp-config-catalog">
      <Stack gap={5}>
        {LP_VERSIONS.map((v) => (
          <div key={v.id} className={styles.catalogItem} data-testid={`fe2-lp-version-${v.id}`}>
            <div className={styles.statusRow}>
              <strong>{v.name}</strong>
              {v.id === publishedVersionId ? (
                <Badge tone="success">公開中</Badge>
              ) : v.status === "draft" ? (
                <Badge tone="warning">準備中</Badge>
              ) : null}
            </div>
            <p className={styles.note}>{v.description}</p>
            <div className={styles.statusRow}>
              {v.prUrl ? (
                <a className={styles.urlOpen} href={v.prUrl} target="_blank" rel="noopener noreferrer">
                  変更の PR を開く
                </a>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                iconRight={<Icon name="external-link" />}
                onClick={() => onView({ ...v, url: lpViewUrl(v.id, v.url, publishState) })}
                testId={`fe2-lp-view-${v.id}`}
              >
                見る
              </Button>
            </div>
          </div>
        ))}
      </Stack>
    </Drawer>
  );
}
