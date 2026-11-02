// LP管理 — 「公開設定」タブ（/lp）。旧「バージョン」「プレビュー」タブを統合した画面。
//
// テーマエディタ型のレイアウト（ページ自体はスクロールしない。各ペインが自分の中だけスクロールする）:
//   上: 操作帯（環境の切り替え・保存状態・プレビューを開く・本番の LP・変更件数・反映）
//   左: セクションの一覧（本番反映 + LP のセクション。今のバリアント・表示・変更ありが一目で分かる）
//   中: LP のプレビュー（メインのキャンバス。中でスクロール・クリックでセクションを選べる）
//   右: インスペクタ（選んだ 1 つだけの設定）
// 連動は「選択」でつなぐ: 一覧で選ぶ → プレビューがそのセクションへ移動 / プレビューをスクロール →
// 一覧で表示中のセクションに印（セクションを選んでいるときはそれを選び直す）/ プレビューでクリック → 選ぶ。
// 狭い画面（1100px 以下）は「プレビュー | 設定」の切り替えにして、ペイン同士がスクロールを奪い合わないようにする。
//  - 下書き: 変えるたびに自動保存（楽観的・失敗で戻す・409 は読み直し）。確認ダイアログは出さない。
//  - 本番: 変更は画面に溜めて「変更 N 件」と差分を出し、「本番に反映」→ 確認ダイアログでまとめて 1 回で反映する。
//    チケット販売を公開にする変更を含むときは ack チェックを必須にする。lp:publish が無ければ操作は無効。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lp } from "@dub/types";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Icon,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonList,
  Stack,
  Switch,
  useMediaQuery,
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
import { LpMiniPreview, type ScrollRequest } from "./LpMiniPreview.tsx";
import { LP_VERSIONS, type LpVersion } from "./lpVersions.ts";
import { LpViewer } from "./LpViewer.tsx";
import { LpTabs } from "./LpTabs.tsx";
import styles from "./lp.module.css";

const ENV_OPTIONS = [
  { value: "draft" as const, label: "プレビュー（下書き）", testId: "fe2-lp-config-env-draft" },
  { value: "live" as const, label: "本番", testId: "fe2-lp-config-env-live" },
];

type PaneTab = "preview" | "settings";
const PANE_OPTIONS = [
  { value: "preview" as const, label: "プレビュー", testId: "fe2-lp-config-pane-preview" },
  { value: "settings" as const, label: "設定", testId: "fe2-lp-config-pane-settings" },
];

/** 一覧で選べるもの: 本番反映 + LP のセクション。 */
export type LpConfigItem = "release" | lp.LpSectionId;

/** これより狭いと 3 ペインを並べず「プレビュー | 設定」の切り替えにする。 */
const SPLIT_BREAKPOINT_QUERY = "(max-width: 1100px)";
/** セクションの切り替え（?config=draft・data-lp-*）を描ける最初の LP の版。 */
const SECTION_CAPABLE_VERSION = "v3.6";
// demo-seed の isDemoEnabled と同じ判定（demo-seed は大きいので import しない）。
const DEMO_ENV = (import.meta.env as { VITE_DEMO?: string }).VITE_DEMO;
const IS_DEMO = DEMO_ENV === "1" || DEMO_ENV === "true";
/** エディタの下に残す余白（シェルの本文の下 padding ぶん）。 */
const EDITOR_BOTTOM_GAP = 24;

export const PUBLISH_CONFIRM_TITLE = "これは本番です。反映してよいですか？";

/** 画面の残りの高さいっぱいにする（ページをスクロールさせない）。 */
function useFillHeight(ref: React.RefObject<HTMLElement>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = (): void => {
      const top = el.getBoundingClientRect().top;
      setHeight(Math.max(480, Math.floor(window.innerHeight - top - EDITOR_BOTTOM_GAP)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [ref]);
  return height;
}

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
  const narrow = useMediaQuery(SPLIT_BREAKPOINT_QUERY);
  const [pane, setPane] = useState<PaneTab>("preview");

  // 選択（一覧 ⇄ プレビュー）。inView はプレビューでいま上に見えているセクション。
  const [selected, setSelected] = useState<LpConfigItem>("release");
  const [inView, setInView] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const editorHeight = useFillHeight(editorRef);

  const state = query.data;
  const live = env === "live";
  const config = state ? (live ? (staged ?? state.published) : state.draft) : null;
  const stagedDiff = useMemo(() => (state && staged ? diffSiteConfig(state.published, staged) : []), [state, staged]);
  const draftDiff = useMemo(() => (state ? diffSiteConfig(state.published, state.draft) : []), [state]);
  const canChange = live ? canPublish && !publish.isPending : canEdit;
  // 一覧の「変更あり」: 下書きは本番との差、本番はためた変更。
  const changedKeys = useMemo(() => new Set((live ? stagedDiff : draftDiff).map((d) => d.key.split(".")[0] ?? d.key)), [live, stagedDiff, draftDiff]);

  const selectItem = (item: LpConfigItem): void => {
    setSelected(item);
    if (item !== "release") setScrollRequest((prev) => ({ section: item, seq: (prev?.seq ?? 0) + 1 }));
  };
  const isSection = (id: string): id is lp.LpSectionId => (lp.LP_SECTION_IDS as string[]).includes(id);
  /** プレビューをスクロールした: 表示中の印を動かし、セクションを選んでいるならそれも合わせる（何も動かさない）。 */
  const onPreviewScroll = (section: string): void => {
    if (!isSection(section)) return;
    setInView(section);
    setSelected((cur) => (cur === "release" ? cur : section));
  };
  /** プレビューでセクションをクリックした: それを選ぶ。 */
  const onPreviewSelect = (section: string): void => {
    if (!isSection(section)) return;
    setInView(section);
    setSelected(section);
    if (narrow) setPane("settings");
  };

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

  // プレビュー。下書きは保存済みの下書き（&config=draft）を保存のたび（revision）に読み直す。
  // 本番は版を番号で固定して &config=live（?version=live はプレビュー扱いにならず連動の橋渡しが入らない）。
  // ためた変更のうち版・チケット・募集は URL で当たる。セクションの見た目は反映後に映る（注記）。
  const mini = state && config
    ? live
      ? { url: `${releasePreviewUrl(config)}&config=live`, refreshKey: 0 }
      : { url: draftPreviewUrl(state.draft), refreshKey: state.revision }
    : null;
  const miniNote = !state || !config
    ? null
    : live && stagedDiff.some((d) => d.key.includes("."))
      ? "セクションの未反映の変更は、本番に反映するとプレビューに映ります（プレビュー（下書き）なら変えた直後に確かめられます）。"
      : IS_DEMO
        ? "デモ環境です。セクションの切り替えが LP に映るのは、LP の v3.6 がデプロイされてからです。"
        : config.release.versionId !== SECTION_CAPABLE_VERSION
          ? `セクションの切り替えが映るのは ${SECTION_CAPABLE_VERSION} 以降の版です（いまの版では見た目は変わりません）。`
          : null;

  const actions = state ? (
    live ? (
      <>
        <Badge tone={stagedDiff.length > 0 ? "warning" : "neutral"} testId="fe2-lp-config-change-count">
          変更 {stagedDiff.length} 件
        </Badge>
        <Button variant="secondary" size="sm" disabled={stagedDiff.length === 0} onClick={() => setStaged(null)} testId="fe2-lp-config-discard">
          取り消す
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canPublish || stagedDiff.length === 0 || publish.isPending}
          onClick={() => staged && setConfirm({ from: state.published, to: staged, source: "live" })}
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
          disabled={!canEdit || draftDiff.length === 0 || reset.isPending}
          onClick={() => setResetting(true)}
          testId="fe2-lp-config-reset"
        >
          本番の内容に戻す
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canPublish || draftDiff.length === 0 || publish.isPending}
          onClick={() => setConfirm({ from: state.published, to: state.draft, source: "draft" })}
          testId="fe2-lp-config-publish-draft"
        >
          この下書きを本番へ反映…
        </Button>
      </>
    )
  ) : null;

  let workspace: JSX.Element;
  if (query.isLoading) {
    workspace = (
      <div className={styles.workspace} data-testid="fe2-lp-config-loading">
        <div className={styles.pane}>
          <SkeletonList rows={6} />
        </div>
        {!narrow ? (
          <div className={styles.pane}>
            <Skeleton variant="rect" width="100%" height="100%" />
          </div>
        ) : null}
        {!narrow ? (
          <div className={styles.pane}>
            <SkeletonList rows={4} />
          </div>
        ) : null}
      </div>
    );
  } else if (query.isError || !state || !config) {
    workspace = (
      <ErrorState
        testId="fe2-lp-config-error"
        error={{ code: "INTERNAL", message: "公開設定を読み込めませんでした。" }}
        onRetry={() => void query.refetch()}
      />
    );
  } else {
    const list = (
      <SectionList
        config={config}
        selected={selected}
        inView={inView}
        changed={changedKeys}
        disabled={!canChange}
        onSelect={(item) => {
          selectItem(item);
        }}
        onChange={onChange}
        stagedDiff={live ? stagedDiff : []}
      />
    );
    const inspector = (
      <Inspector
        item={selected}
        config={config}
        publishedVersionId={state.published.release.versionId}
        disabled={!canChange}
        onChange={onChange}
        onOpenCatalog={() => setCatalogOpen(true)}
      />
    );
    const canvas = mini ? (
      <LpMiniPreview
        url={mini.url}
        refreshKey={mini.refreshKey}
        title={live ? "本番のプレビュー" : "下書きのプレビュー"}
        note={miniNote}
        scrollRequest={scrollRequest}
        onActiveSection={onPreviewScroll}
        onSelectSection={onPreviewSelect}
        fill
      />
    ) : null;
    workspace = narrow ? (
      <div className={styles.workspaceNarrow}>
        {/* 両方とも描いたまま隠す（プレビューを読み直さない・連動を切らない）。 */}
        <div className={styles.paneFill} hidden={pane !== "preview"}>
          {canvas}
        </div>
        <div className={styles.pane} hidden={pane !== "settings"}>
          <Stack gap={6}>
            {list}
            {inspector}
          </Stack>
        </div>
      </div>
    ) : (
      <div className={styles.workspace}>
        <nav className={styles.pane} aria-label="セクション">
          {list}
        </nav>
        <div className={styles.paneFill}>{canvas}</div>
        <aside className={styles.pane} aria-label="選んだ項目の設定">
          {inspector}
        </aside>
      </div>
    );
  }

  return (
    <div ref={editorRef} className={styles.editor} style={{ height: editorHeight }} data-testid="fe2-lp-config-screen">
      <PageHeader
        testId="fe2-lp-header"
        title="LP管理"
        description={narrow ? undefined : "LP の見た目と公開状態を、下書きで確かめてから本番に反映します。"}
      />
      <LpTabs active="config" />
      <AppReadOnlyNotice appId="lp" />
      <div className={styles.stickyBar} data-env={env} data-testid="fe2-lp-config-actionbar">
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
        <a className={styles.urlOpen} href={LP_PUBLIC_URL} target="_blank" rel="noopener noreferrer" data-testid="fe2-lp-config-live-url">
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
      {live && state ? (
        <p className={styles.liveBanner} data-testid="fe2-lp-config-live-banner">
          <Icon name="flag" />
          <span>
            本番の設定です。変更は「本番に反映」を押して確認するまで公開されません。
            {!canPublish ? " 変更には lp:publish 権限が必要です。" : ""}
          </span>
        </p>
      ) : null}
      {narrow && state ? (
        <SegmentedControl<PaneTab>
          aria-label="表示する画面"
          size="sm"
          value={pane}
          onChange={setPane}
          options={PANE_OPTIONS}
          testId="fe2-lp-config-pane"
        />
      ) : null}
      {workspace}
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
    </div>
  );
}

/** 左: 一覧。各行は「選ぶボタン」と（非表示にできるセクションなら）その場の表示スイッチ。 */
function SectionList({
  config,
  selected,
  inView,
  changed,
  disabled,
  onSelect,
  onChange,
  stagedDiff,
}: {
  config: LpSiteConfig;
  selected: LpConfigItem;
  inView: string | null;
  changed: Set<string>;
  disabled: boolean;
  onSelect: (item: LpConfigItem) => void;
  onChange: (next: LpSiteConfig) => void;
  stagedDiff: ConfigDiff[];
}): JSX.Element {
  const releaseChanged = ["versionId", ...RELEASE_FLAGS.map((f) => f.key)].some((k) => changed.has(k));
  const r = config.release;
  return (
    <div className={styles.itemList} data-selected={selected} data-in-view={inView ?? ""} data-testid="fe2-lp-config-list">
      <p className={styles.paneTitle}>本番反映</p>
      <div className={styles.item} data-active={selected === "release"} data-testid="fe2-lp-config-item-release">
        <button type="button" className={styles.itemButton} onClick={() => onSelect("release")} aria-pressed={selected === "release"}>
          <span className={styles.itemName}>
            版・チケット・募集
            {releaseChanged ? <span className={styles.changedDot} aria-label="変更あり" /> : null}
          </span>
          <span className={styles.itemMeta}>
            <Badge tone="neutral">{r.versionId}</Badge>
            {r.ticketsEnabled ? <Badge tone="success">チケット販売</Badge> : null}
            {r.proposalsEnabled ? <Badge tone="success">登壇者募集</Badge> : null}
          </span>
        </button>
      </div>
      <p className={styles.paneTitle}>セクション</p>
      {lp.LP_SECTION_IDS.map((id) => {
        const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
        const cur = lp.resolveSection(config.layout, id);
        return (
          <div key={id} className={styles.item} data-active={selected === id} data-testid={`fe2-lp-config-item-${id}`}>
            <button type="button" className={styles.itemButton} onClick={() => onSelect(id)} aria-pressed={selected === id}>
              <span className={styles.itemName}>
                {def.label}
                {changed.has(id) ? <span className={styles.changedDot} aria-label="変更あり" /> : null}
                {inView === id ? <span className={styles.inViewTag}>表示中</span> : null}
              </span>
              <span className={styles.itemMeta}>
                <Badge tone="neutral">{def.variants[cur.variant] ?? cur.variant}</Badge>
                {!cur.visible ? <Badge tone="warning">非表示</Badge> : null}
              </span>
            </button>
            {def.hideable ? (
              <Switch
                id={`fe2-lp-config-${id}-visible`}
                testId={`fe2-lp-config-${id}-visible`}
                checked={cur.visible}
                disabled={disabled}
                label={<span className={styles.srOnly}>{def.label}を表示</span>}
                onChange={(v) => onChange(setSection(config, id, { visible: v }))}
              />
            ) : null}
          </div>
        );
      })}
      {stagedDiff.length > 0 ? (
        <div className={styles.stagedBox} data-testid="fe2-lp-config-staged">
          <p className={styles.paneTitle}>未反映の変更</p>
          <DiffList diff={stagedDiff} testId="fe2-lp-config-staged-diff" />
        </div>
      ) : null}
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div className={styles.inspectorRow}>
      <span className={styles.configRowLabel}>
        <span>{label}</span>
        {hint ? <span className={styles.note}>{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** 右: 選んだ 1 項目の設定だけ。 */
function Inspector({
  item,
  config,
  publishedVersionId,
  disabled,
  onChange,
  onOpenCatalog,
}: {
  item: LpConfigItem;
  config: LpSiteConfig;
  publishedVersionId: string;
  disabled: boolean;
  onChange: (next: LpSiteConfig) => void;
  onOpenCatalog: () => void;
}): JSX.Element {
  if (item === "release") {
    const options = lp.LP_PUBLISHABLE_VERSION_IDS.map((id) => ({
      value: id as string,
      label: `${versionName(id)}${id === publishedVersionId ? "（公開中）" : ""}`,
    }));
    return (
      <section className={styles.inspector} data-testid="fe2-lp-config-release" aria-label="本番反映">
        <h2 className={styles.sectionTitle}>本番反映</h2>
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
          <SettingRow key={f.key} label={f.label} hint={f.key === "ticketsCtaEnabled" ? "チケット販売が公開のときだけ効きます。" : undefined}>
            <Switch
              id={`fe2-lp-config-${f.key}`}
              testId={`fe2-lp-config-${f.key}`}
              checked={config.release[f.key]}
              disabled={disabled}
              label={config.release[f.key] ? f.on : f.off}
              onChange={(v) => onChange(setRelease(config, f.key, v))}
            />
          </SettingRow>
        ))}
      </section>
    );
  }
  const id = item;
  const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
  const cur = lp.resolveSection(config.layout, id);
  const variants = Object.entries(def.variants).map(([value, label]) => ({ value, label }));
  return (
    <section className={styles.inspector} data-testid={`fe2-lp-config-section-${id}`} aria-label={def.label}>
      <h2 className={styles.sectionTitle}>{def.label}</h2>
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
          id="fe2-lp-config-inspector-visible"
          testId="fe2-lp-config-inspector-visible"
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
