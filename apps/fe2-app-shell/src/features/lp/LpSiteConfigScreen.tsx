// LP管理 — 「公開設定」タブ（/lp）。旧「バージョン」「プレビュー」タブを統合した画面。
//
// 上部の切り替え（URL の ?env=draft|live）で「プレビュー（下書き）」と「本番」を描き分けるが、中身は共通:
//   本番反映のカード（公開する版・チケット販売・参加登録ボタン差し替え・登壇者募集）/
//   LP とセクションの設定を 1 枚にしたカード（左に LP、右にそのセクションの高さで設定。ページと一緒にスクロール）。
// セクションの設定は登録簿（LP_SECTION_REGISTRY）から汎用に描くので、バリアント・オプションを足すと自動で出る。
//  - 下書き: 変えるたびに自動保存（楽観的・失敗で戻す・409 は読み直し）。確認ダイアログは出さない。
//    ミニプレビューは切り替えた瞬間に映る（画面上の設定を postMessage で LP に送る・本番は変えない）。
//    「プレビューを開く」は下書きの値で LP を開く（&config=draft）。本番の LP はこのタブからは変えられない:
//    「本番タブで確かめる」は下書きを本番タブの未反映の変更として読み込むだけで、何も書き込まない。
//  - 本番: 変更は画面に溜めて「変更 N 件」と差分を出し、「本番に反映」→ 確認ダイアログでまとめて 1 回で反映する。
//    チケット販売を公開にする変更を含むときは ack チェックを必須にする。lp:publish が無ければ操作は無効。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  Skeleton,
  SkeletonCard,
  SkeletonList,
  Stack,
  Switch,
  useMediaQuery,
} from "@dub/ui";
import { useAppCapability, usePermissions } from "../../auth/AuthProvider.tsx";
import { usePermissionGate } from "../../auth/PermissionGate.tsx";
import type { LpSiteConfig } from "./lpApi.tsx";
import { useLpApi } from "./LpProvider.tsx";
import { useLpTickets } from "./lpTicketsHooks.ts";
import {
  diffSiteConfig,
  draftPreviewUrl,
  enablesTickets,
  releasePreviewUrl,
  parseEnv,
  RELEASE_FLAGS,
  setRelease,
  setSection,
  versionName,
  type ConfigDiff,
  type LpConfigEnv,
} from "./lpSiteConfig.ts";
import { useDraftAutosave, useLpSiteConfig, usePublishSiteConfig, useResetDraft } from "./lpSiteConfigHooks.ts";
import { formatSwitchedAt, LP_PUBLIC_URL, lpViewUrl } from "./lpPublish.ts";
import { LpSectionEditor } from "./LpSectionEditor.tsx";
import { LP_VERSIONS, type LpVersion } from "./lpVersions.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

const ENV_OPTIONS = [
  { value: "draft" as const, label: "プレビュー（下書き）", testId: "fe2-lp-config-env-draft" },
  { value: "live" as const, label: "本番", testId: "fe2-lp-config-env-live" },
];

/** これより狭いと LP と設定を横に並べず、設定を縦に並べてプレビューは開閉する枠にする。 */
const SPLIT_BREAKPOINT_QUERY = "(max-width: 1100px)";
/** セクションの切り替え（?config=draft・data-lp-*）を描ける最初の LP の版。 */
const SECTION_CAPABLE_VERSION = "v3.6";
// demo-seed の isDemoEnabled と同じ判定（demo-seed は大きいので import しない）。
const DEMO_ENV = (import.meta.env as { VITE_DEMO?: string }).VITE_DEMO;
const IS_DEMO = DEMO_ENV === "1" || DEMO_ENV === "true";

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
  const [confirm, setConfirm] = useState<{ from: LpSiteConfig; to: LpSiteConfig } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [viewing, setViewing] = useState<LpVersion | null>(null);
  const [opening, setOpening] = useState(false);
  const narrow = useMediaQuery(SPLIT_BREAKPOINT_QUERY);
  // 操作帯の高さ（セクションの設定はその下に貼り付く）。
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setBarHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const state = query.data;
  const live = env === "live";
  const config = state ? (live ? (staged ?? state.published) : state.draft) : null;
  const stagedDiff = useMemo(() => (state && staged ? diffSiteConfig(state.published, staged) : []), [state, staged]);
  const draftDiff = useMemo(() => (state ? diffSiteConfig(state.published, state.draft) : []), [state]);
  const canChange = live ? canPublish && !publish.isPending : canEdit;
  // 権限が足りない人が押したら権限不足ダイアログ(申請付き)。本番は lp:publish、下書きは LP の編集。
  const gate = usePermissionGate(
    live && canEdit
      ? { appId: "lp", locked: !canPublish, scope: "scope", reason: "本番への反映には lp:publish 権限が必要です。" }
      : { appId: "lp", locked: !canEdit },
  );
  const requestButton = gate.locked ? (
    <Button variant="ghost" size="sm" onClick={gate.open} testId="fe2-lp-config-request-permission">
      権限を申請する
    </Button>
  ) : null;

  const switchEnv = (next: LpConfigEnv): void => {
    if (next !== env) void navigate({ to: "/lp", search: { env: next }, replace: true });
  };

  const onChange = (next: LpSiteConfig): void => {
    if (!state || !canChange) return;
    if (live) setStaged(diffSiteConfig(state.published, next).length > 0 ? next : null);
    else autosave.save(next);
  };

  // 本番への書き込みはここだけ（本番タブの「本番に反映…」→ 確認ダイアログ）。
  const doPublish = (): void => {
    if (!confirm || !live) return;
    const { to } = confirm;
    const restore = staged;
    setConfirm(null);
    setStaged(null);
    publish.mutate({ config: to }, { onError: () => restore && setStaged(restore) });
  };

  // 下書きを本番タブの「未反映の変更」として持っていく。書き込みはしない（反映は本番タブで確認してから）。
  const carryDraftToLive = (): void => {
    if (!state) return;
    setStaged(diffSiteConfig(state.published, state.draft).length > 0 ? structuredClone(state.draft) : null);
    switchEnv("live");
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

  // 左のプレビュー。版・チケット・募集は URL で当たる（変えると読み直す）。セクションの見た目は画面上の設定
  // （下書き = 楽観的に更新済みのキャッシュ / 本番 = ためた変更）を attrs として LP に送り、即時に映す。
  // 下書きは &config=draft、本番は版を番号で固定して &config=live（?version=live はプレビュー扱いにならず橋渡しが入らない）。
  // 即時反映できない古い橋渡しの LP だけ、下書きの保存のたび（revision）に読み直す。
  const miniAttrs = useMemo(() => (config ? lp.layoutAttributes(lp.LP_SECTION_REGISTRY, config.layout) : {}), [config]);
  const mini = state && config
    ? live
      ? { url: `${releasePreviewUrl(config)}&config=live`, refreshKey: 0 }
      : { url: draftPreviewUrl(state.draft), refreshKey: state.revision }
    : null;
  const miniNote = config && config.release.versionId !== SECTION_CAPABLE_VERSION
    ? `セクションの切り替えが映るのは ${SECTION_CAPABLE_VERSION} 以降の版です（いまの版では見た目は変わりません）。`
    : null;
  // 即時反映できない（lp:config を知らない古い橋渡しの）LP のときだけ出す注記。
  const miniNoSyncNote = !state || !config
    ? null
    : live && stagedDiff.some((d) => d.key.includes("."))
      ? "セクションの未反映の変更は、本番に反映するとプレビューに映ります（プレビュー（下書き）なら変えた直後に確かめられます）。"
      : IS_DEMO
        ? "デモ環境です。セクションの切り替えが LP に映るのは、LP の v3.6 がデプロイされてからです。"
        : null;
  // 「変更あり」の印: 下書きは本番との差、本番はためた変更。
  const changedSections = useMemo(
    () => new Set((live ? stagedDiff : draftDiff).map((d) => d.key.split(".")[0] ?? d.key)),
    [live, stagedDiff, draftDiff],
  );

  const actions = state ? (
    live ? (
      <>
        <Badge tone={stagedDiff.length > 0 ? "warning" : "neutral"} testId="fe2-lp-config-change-count">
          変更 {stagedDiff.length} 件
        </Badge>
        <Button
          variant="secondary"
          size="sm"
          disabled={stagedDiff.length === 0}
          onClick={() => setStaged(null)}
          testId="fe2-lp-config-discard"
        >
          取り消す
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={stagedDiff.length === 0 || publish.isPending}
          onClick={gate.guard(() => staged && setConfirm({ from: state.published, to: staged }))}
          testId="fe2-lp-config-publish"
        >
          本番に反映…
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="secondary"
          size="sm"
          disabled={draftDiff.length === 0 || reset.isPending}
          onClick={gate.guard(() => setResetting(true))}
          testId="fe2-lp-config-reset"
        >
          本番の内容に戻す
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={draftDiff.length === 0}
          onClick={carryDraftToLive}
          testId="fe2-lp-config-to-live"
        >
          本番タブで確かめる
        </Button>
      </>
    )
  ) : null;

  let body: JSX.Element;
  if (query.isLoading) {
    body = (
      <Stack gap={6} testId="fe2-lp-config-loading">
        <SkeletonCard lines={4} />
        <div className={styles.lpEditor} data-narrow={narrow}>
          {!narrow ? <Skeleton variant="rect" width="100%" height={480} /> : null}
          <div className={styles.lpEditorSettings}>
            <SkeletonList rows={5} />
          </div>
        </div>
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
            {requestButton}
          </p>
        ) : (
          <p className={styles.previewNotice} data-testid="fe2-lp-config-draft-notice">
            <Icon name="info" />
            <span>
              ここはプレビュー（下書き）です。変えるたびに自動で保存され、プレビューにだけ映ります。本番の LP
              を変えられるのは「本番」タブの「本番に反映…」だけです。
              {!canEdit ? " 閲覧のみの権限のため変更できません。" : ""}
            </span>
            {requestButton}
          </p>
        )}
        {live && stagedDiff.length > 0 ? (
          <Card testId="fe2-lp-config-staged" header={<span className={styles.sectionTitle}>未反映の変更</span>}>
            <DiffList diff={stagedDiff} testId="fe2-lp-config-staged-diff" />
          </Card>
        ) : null}
        <ReleaseCard
          config={config}
          publishedVersionId={state.published.release.versionId}
          disabled={!canChange}
          onChange={onChange}
          onOpenCatalog={() => setCatalogOpen(true)}
        />
        {mini ? (
          <LpSectionEditor
            url={mini.url}
            refreshKey={mini.refreshKey}
            attrs={miniAttrs}
            title={live ? "本番のプレビューとセクションの設定" : "下書きのプレビューとセクションの設定"}
            notes={miniNote ? [miniNote] : []}
            noSyncNotes={miniNoSyncNote ? [miniNoSyncNote] : []}
            narrow={narrow}
            sectionIds={lp.LP_SECTION_IDS}
            sectionLabel={(id) => lp.LP_SECTION_REGISTRY[id as lp.LpSectionId].label}
            renderSection={(id) => (
              <SectionControls
                id={id as lp.LpSectionId}
                config={config}
                changed={changedSections.has(id)}
                disabled={!canChange}
                onChange={onChange}
              />
            )}
          />
        ) : null}
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-config-screen">
      <PageHeader
        testId="fe2-lp-header"
        title="LP管理"
        description="北陸ITカンファレンスのランディングページ（LP）の見た目と公開状態を、下書きで確かめてから本番に反映します。"
      />
      <LpTabs active="config" />
      {gate.dialog}
      {/* 操作は全部この帯に置き、スクロールしても上に貼り付ける（下まで降りなくてよい）。 */}
      <div ref={barRef} className={styles.stickyBar} data-env={env} data-testid="fe2-lp-config-actionbar">
        <SegmentedControl<LpConfigEnv>
          aria-label="環境"
          size="sm"
          value={env}
          onChange={switchEnv}
          options={ENV_OPTIONS.map((o) =>
            o.value === "live" && staged ? { ...o, label: `本番（未反映 ${stagedDiff.length}）` } : o,
          )}
          testId="fe2-lp-config-env"
        />
        {!live ? (
          <Button
            variant="secondary"
            size="sm"
            iconRight={<Icon name="external-link" />}
            disabled={!state || opening}
            onClick={() => void openPreview()}
            testId="fe2-lp-config-preview-open"
          >
            プレビューを開く
          </Button>
        ) : null}
        <a
          className={styles.urlOpen}
          href={LP_PUBLIC_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="fe2-lp-config-live-url"
        >
          本番の LP（{LP_PUBLIC_URL.replace(/^https?:\/\//, "")}）
        </a>
        {status ? (
          <span className={styles.note} data-testid="fe2-lp-config-status">
            {status}
          </span>
        ) : null}
        <span className={styles.actionSpacer} />
        {actions}
      </div>
      <div style={{ "--lp-bar-h": `${barHeight}px` } as CSSProperties}>{body}</div>
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
          <div className={styles.versionPick}>
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

/** 1 セクションの設定（右の列に、LP のそのセクションの高さで置く）。 */
function SectionControls({
  id,
  config,
  changed,
  disabled,
  onChange,
}: {
  id: lp.LpSectionId;
  config: LpSiteConfig;
  changed: boolean;
  disabled: boolean;
  onChange: (next: LpSiteConfig) => void;
}): JSX.Element {
  const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
  const cur = lp.resolveSection(config.layout, id);
  const variants = Object.entries(def.variants).map(([value, label]) => ({ value, label }));
  const options = Object.entries(def.options ?? {});
  // 非表示のセクションのパターン・オプションは選べない（表示にしたときに選ぶ）。
  const hiddenNow = !cur.visible;
  return (
    <section className={styles.lpEditorSection} data-testid={`fe2-lp-config-section-${id}`}>
      <div className={styles.lpBlockHead}>
        <span>{def.label}</span>
        {changed ? <span className={styles.changedDot} aria-label="変更あり" title="変更あり" /> : null}
        <span className={styles.actionSpacer} />
        <Switch
          id={`fe2-lp-config-${id}-visible`}
          testId={`fe2-lp-config-${id}-visible`}
          checked={cur.visible}
          disabled={disabled || !def.hideable}
          label={cur.visible ? "表示" : "非表示"}
          onChange={(v) => onChange(setSection(config, id, { visible: v }))}
        />
      </div>
      {variants.length === 1 && options.length > 0 ? null : (
        <div className={styles.lpBlockRow}>
          <span>バリアント</span>
          {variants.length >= 2 && variants.length <= 4 ? (
            <SegmentedControl<string>
              aria-label={`${def.label}のバリアント`}
              size="sm"
              value={cur.variant}
              onChange={(v) => onChange(setSection(config, id, { variant: v }))}
              options={variants.map((o) => ({ ...o, disabled, testId: `fe2-lp-config-${id}-variant-${o.value}` }))}
              testId={`fe2-lp-config-${id}-variant`}
            />
          ) : variants.length > 4 ? (
            <Select
              id={`fe2-lp-config-${id}-variant`}
              testId={`fe2-lp-config-${id}-variant`}
              value={cur.variant}
              disabled={disabled}
              onChange={(v) => onChange(setSection(config, id, { variant: v }))}
              options={variants}
            />
          ) : (
            <span className={styles.note} data-testid={`fe2-lp-config-${id}-variant`}>
              {variants[0]?.label}（1 種類だけ）
            </span>
          )}
        </div>
      )}
      {!def.hideable ? <span className={styles.note}>このセクションは常に表示されます。</span> : null}
      {options.map(([key, od]) => (
        <div key={key} className={styles.lpBlockRow}>
          <span>{od.label}</span>
          {od.kind === "boolean" ? (
            <Switch
              id={`fe2-lp-config-${id}-${key}`}
              testId={`fe2-lp-config-${id}-${key}`}
              checked={cur.options[key] === true}
              disabled={disabled || hiddenNow}
              label={cur.options[key] === true ? "表示" : "非表示"}
              onChange={(v) => onChange(setSection(config, id, { option: { key, value: v } }))}
            />
          ) : Object.keys(od.values ?? {}).length >= 2 && Object.keys(od.values ?? {}).length <= 4 ? (
            <SegmentedControl<string>
              aria-label={`${def.label}の${od.label}`}
              size="sm"
              value={String(cur.options[key])}
              onChange={(v) => onChange(setSection(config, id, { option: { key, value: v } }))}
              options={Object.entries(od.values ?? {}).map(([value, label]) => ({
                value,
                label,
                disabled: disabled || hiddenNow,
                testId: `fe2-lp-config-${id}-${key}-${value}`,
              }))}
              testId={`fe2-lp-config-${id}-${key}`}
            />
          ) : (
            <Select
              id={`fe2-lp-config-${id}-${key}`}
              testId={`fe2-lp-config-${id}-${key}`}
              value={String(cur.options[key])}
              disabled={disabled || hiddenNow}
              onChange={(v) => onChange(setSection(config, id, { option: { key, value: v } }))}
              options={Object.entries(od.values ?? {}).map(([value, label]) => ({ value, label }))}
            />
          )}
        </div>
      ))}
    </section>
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
