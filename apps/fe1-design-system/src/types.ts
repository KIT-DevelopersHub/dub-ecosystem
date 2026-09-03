// @dub/ui — frozen public contract types (FE1 §2-3, P0b 凍結案).
// FE2〜FE8 depend on these Props shapes without reading the implementation.
// FE1 never imports @dub/types / @dub/errors (leaf package). `DisplayableError`
// below is the single display-only projection FE2 api-client produces via
// `toDisplayableError` (凍結案 1-4-4).
import type { ReactNode } from "react";

export type Size = "sm" | "md" | "lg";
export type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * data-testid convention (integration-e2e 正本・凍結案 1-7) enforcement handle.
 * Every public component extends this and passes `testId` through to the DOM
 * `data-testid`. Naming: "<unit>-<screen>-<element>" (e.g. "fe3-event-list-item").
 */
export interface TestableProps {
  testId?: string;
}

/**
 * The one true icon-name resolution (凍結案 1-1-7). Closed union over a Lucide
 * subset. FE2 NavEntry.icon / FE3 ActionTypePlugin.icon / FE5 型辞書 icon use
 * `IconName`, never `string`. Extend (keep closed) as P1 needs more.
 */
export type IconName =
  | "home"
  | "calendar"
  | "check-square"
  | "bell"
  | "message-circle"
  | "users"
  | "settings"
  | "search"
  | "plus"
  | "edit"
  | "trash"
  | "chevron-down"
  | "chevron-right"
  | "external-link"
  | "alert-triangle"
  | "info"
  | "x"
  | "menu"
  | "log-out"
  | "shield"
  | "lock"
  // P1 additions (fe2〜fe7 needs beyond the original 20; keep closed, additive-only)
  | "task"
  | "list"
  | "alert"
  | "chat"
  | "warning"
  | "viewport"
  | "inbox"
  | "message-square"
  | "scope"
  | "megaphone"
  | "user"
  | "history"
  | "file"
  | "drag"
  | "refresh"
  | "flag"
  | "clock"
  | "check"
  | "check-all"
  | "bell-off"
  | "archive"
  | "folder"
  | "folder-open"
  // chat + rich-text formatting (fe6). Additive, closed-union preserved.
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "code-block"
  | "quote"
  | "list-ordered"
  | "link"
  | "smile"
  | "at-sign"
  | "paperclip"
  | "send"
  | "reply"
  | "pin"
  | "hash";

export interface IconProps extends TestableProps {
  name: IconName;
  size?: Size; // default "md"
  "aria-label"?: string; // decorative use omits it -> aria-hidden
  className?: string;
}

export interface ButtonProps extends TestableProps {
  variant?: Variant; // default "primary"
  size?: Size; // default "md"
  loading?: boolean; // shows spinner, disables click
  disabled?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

export interface IconButtonProps extends TestableProps {
  name: IconName;
  "aria-label": string; // required — icon-only button must be labelled
  variant?: Variant; // default "ghost"
  size?: Size; // default "md"
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
}

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";
export interface BadgeProps extends TestableProps {
  tone?: BadgeTone; // default "neutral"
  children: ReactNode;
}

export interface TagProps extends TestableProps {
  tone?: BadgeTone;
  onRemove?: () => void; // shows an x affordance when present
  children: ReactNode;
}

export interface AvatarProps extends TestableProps {
  name: string; // used for initials + alt
  src?: string;
  size?: Size;
}

export interface SpinnerProps extends TestableProps {
  size?: Size;
  "aria-label"?: string; // default "読み込み中"
}

export interface TooltipProps extends TestableProps {
  content: ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

export interface FormProps extends TestableProps {
  onSubmit: () => void;
  children: ReactNode;
}

export interface FormFieldProps extends TestableProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string; // shown below input, sets aria-invalid on the described input
  help?: string;
  children: ReactNode;
}

export interface TextFieldProps extends TestableProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: Size;
  invalid?: boolean;
  disabled?: boolean;
  type?: "text" | "email" | "password" | "url" | "number";
  "aria-describedby"?: string;
}

export interface TextareaProps extends TestableProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}
export interface SelectProps<V extends string = string> extends TestableProps {
  id: string;
  value: V | null;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
}

export interface CheckboxProps extends TestableProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioProps extends TestableProps {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: ReactNode;
  disabled?: boolean;
}

export interface SwitchProps extends TestableProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}

// v1 = native `input type="date"` wrapper (凍結案 1-6-4).
export interface DatePickerProps extends TestableProps {
  id: string;
  value: string | null; // ISO yyyy-mm-dd
  onChange: (value: string | null) => void;
  min?: string;
  max?: string;
  invalid?: boolean;
  disabled?: boolean;
}

export interface ColumnDef<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  width?: string;
  /**
   * Minimum column width (any CSS length, e.g. "12rem"). Applied to both the
   * header and body cells so a wide table keeps its natural width and scrolls
   * horizontally inside DataTable's `overflow-x:auto` wrapper instead of
   * squeezing columns until their text wraps (多列テーブルの折り返し崩れ対策).
   */
  minWidth?: string;
  /**
   * Keep this column's cells on a single line (`white-space: nowrap`). Header
   * cells are already nowrap; opt body cells in for values that must not wrap
   * (氏名・ステータス・操作ボタン等). Chip/tag columns can leave this off to wrap.
   */
  noWrap?: boolean;
  sortable?: boolean;
  align?: "left" | "center" | "right";
  /**
   * Whether this column can be toggled off from the「表示列」picker (see
   * DataTableProps.columnHiding). Defaults to `true`. Set `false` for anchor /
   * action columns that must always render (氏名の行を識別する列・操作ボタン列など);
   * they stay visible and are omitted from the picker.
   */
  hideable?: boolean;
  /**
   * When column hiding is enabled, start this column hidden until the user turns
   * it on. Lets a 多列テーブル open with only its主要列 (横スクロール最小) while the
   * rest stay one checkbox away. Ignored unless `columnHiding` is set.
   */
  defaultHidden?: boolean;
  /**
   * Plain-text label for this column in the「表示列」picker. Falls back to
   * `header` when it is a string, otherwise to `key`. Provide it when `header`
   * is a ReactNode (icon 等) so the picker checkbox still reads clearly.
   */
  pickerLabel?: string;
}
export interface SortState {
  key: string;
  direction: "asc" | "desc";
}
export interface DataTableProps<Row> extends TestableProps {
  columns: ColumnDef<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  loading?: boolean;
  emptyState?: ReactNode;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  onRowClick?: (row: Row) => void;
  selection?: { selectedKeys: string[]; onChange: (keys: string[]) => void };
  /**
   * Opt-in「表示列」picker: a toolbar button above the table lets the user choose
   * which columns show (checkbox per hideable column). The選択 is persisted per
   * user in `localStorage` under `storageKey`, so a reload keeps it. Columns with
   * `defaultHidden` start off; `hideable === false` columns are always shown and
   * excluded from the picker. Toggling is optimistic (即 UI 反映). Omit to keep the
   * table exactly as before (all columns always visible, no toolbar).
   */
  columnHiding?: { storageKey: string; label?: string };
  /**
   * Opt-in row virtualization (windowing) for長い一覧. When set, the table body
   * scrolls inside a fixed-height viewport and only the rows in view (+ overscan)
   * are mounted, so 数百〜数千行でも初期描画とスクロールが滑らか。行の高さは実測する
   * ので可変高さ行にも対応。ソート/選択/フィルタ/行クリック/表示列は不変(additive)。
   * `threshold` 以下の行数では従来どおり全行を描画し、コンテナも挟まない。測定不能な
   * 環境(SSR/テスト)では自動的に全行描画へフォールバックする。
   */
  virtualize?: {
    /** 行数がこれ以下なら仮想化しない (default 100)。 */
    threshold?: number;
    /** 目安の行高さ px。初期ウィンドウとスクロールバー長の見積りに使う (default 48)。 */
    estimateRowHeight?: number;
    /** 内部スクロール領域の高さ px。これを超えた分は表内でスクロールする (default 560)。 */
    maxHeight?: number;
    /** ビューポート上下に余分に描画する行数 (default 8)。 */
    overscan?: number;
  };
}

// offset paging — only for totalCount APIs (凍結案 1-6-3). cursor lists use LoadMore.
export interface PaginationProps extends TestableProps {
  page: number; // 1-based
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

// cursor "load more" button (no auto-firing infinite scroll・凍結案 1-6-3)
export interface LoadMoreProps extends TestableProps {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  label?: string; // default "さらに読み込む"
}

export interface ModalProps extends TestableProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: Size | "full";
  footer?: ReactNode;
  closeOnOverlayClick?: boolean; // default true
  children: ReactNode;
}

export interface ConfirmDialogProps extends TestableProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean; // destructive style
  onConfirm: () => void | Promise<void>; // loading while pending
  onCancel: () => void;
}

/** One line of a validation breakdown shown inside an ErrorDialog (400 details). */
export interface ErrorDialogDetail {
  /** field / cause key (e.g. "dueAt"). Optional — a bare message line is fine. */
  label?: string;
  message: string;
}

/**
 * Blocking error surface: a modal that makes a failed action's REASON impossible
 * to miss (the counterpart to the quiet inline field error). Reusable across apps
 * — feed it any `DisplayableError`; optionally list the validation `details` and a
 * `retry`. Use for failures the user cannot otherwise see (save silently dropped,
 * permission denied, dependency cycle, "期間未入力", server/network errors).
 */
export interface ErrorDialogProps extends TestableProps {
  open: boolean;
  /** Short dialog heading (default "処理できませんでした"). */
  title?: string;
  error: DisplayableError;
  /** Optional per-field / per-cause breakdown (from a 400 validation response). */
  details?: readonly ErrorDialogDetail[];
  /** Optional guidance line under the message (how to fix it). */
  hint?: ReactNode;
  onClose: () => void;
  closeLabel?: string; // default "閉じる"
  /** When provided, shows a 再試行 button that re-runs the failed action. */
  onRetry?: () => void;
  retryLabel?: string; // default "再試行"
}

export interface DrawerProps extends TestableProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  side?: "left" | "right";
  children: ReactNode;
}

export interface PopoverProps extends TestableProps {
  trigger: ReactNode;
  open?: boolean; // uncontrolled if omitted
  onOpenChange?: (open: boolean) => void;
  placement?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

// Menu (dropdown): a trigger button + a flat list of action items. The generic
// disclosure primitive for header "設定"/kebab menus. Router-free — each item
// carries `onSelect`; the panel closes on select, outside-click and Escape.
export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  onSelect: () => void;
  testId?: string;
  tone?: "default" | "danger"; // "danger" styles destructive/離脱 actions (e.g. logout)
  dividerBefore?: boolean; // render a separator above this item (group離脱 actions)
}
export interface MenuProps extends TestableProps {
  label: string; // trigger button text (also the aria-label when iconOnly)
  items: MenuItem[];
  icon?: IconName; // trigger leading icon (e.g. "settings")
  variant?: Variant; // trigger button variant (default "ghost")
  align?: "start" | "end"; // panel horizontal alignment (default "end")
  menuLabel?: string; // aria-label for the panel (defaults to `label`)
  // Icon-only trigger: renders a 40px square icon button (matching the header
  // AppLauncher/bell controls) instead of a labelled Button. `icon` is required
  // and `label` becomes the button's aria-label; the chevron is dropped.
  iconOnly?: boolean;
}

// Toast contract is authoritative here (凍結案 1-4-3). FE2 re-exports useToast;
// FE3〜FE7 use these 4 kinds.
export type ToastKind = "success" | "error" | "info" | "warning";
export interface ToastOptions {
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number; // default 5000; error sticks until closed
}

export type ThemeName = "light" | "dark";
// controlled (凍結案 1-4-2): theme prop required, no internal persistence.
// "system" resolution + localStorage("dub.ui.theme") are owned by FE2 UiStore.
export interface ThemeProviderProps {
  theme: ThemeName;
  children: ReactNode;
}

export interface AppShellProps extends TestableProps {
  // Optional (凍結案 1-4-3): when omitted the shell renders no left rail and the
  // main column spans full width. FE2's app-launcher model drops the persistent
  // sidebar in favour of the header AppLauncher, so mail/chat get the full canvas.
  sidebar?: ReactNode;
  header?: ReactNode;
  children: ReactNode; // main content
}

/** One tool tile in the header AppLauncher (Chrome-waffle model). */
export interface AppLauncherItem {
  id: string;
  label: string;
  icon?: IconName; // resolved via FE1 Icon
  href?: string; // consumer's renderLink/onSelect maps this to router navigation
  badgeCount?: number;
  // Release-gating: a tile the current viewer may NOT open yet is kept in the grid
  // (never removed — 消さない) but rendered greyed-out, non-clickable and with a
  // tooltip. Visibility/eligibility is decided upstream by whoever builds `items`;
  // this component only renders the disabled state and suppresses onSelect.
  disabled?: boolean;
  disabledReason?: string; // tooltip text shown on the greyed tile (e.g. 準備中)
}
export interface AppLauncherProps extends TestableProps {
  items: AppLauncherItem[];
  onSelect?: (item: AppLauncherItem) => void; // click/Enter on a tile
  label?: string; // aria-label for the waffle trigger (default: "アプリ")
  title?: string; // heading shown atop the popover grid
  // Placeholder + aria-label for the filter box shown when the popover opens. The
  // box narrows the *displayed* tiles by substring; it never removes apps from the
  // catalog (消さない). Default: "アプリを検索".
  searchPlaceholder?: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  icon?: IconName; // resolved via FE1 Icon (was ReactNode; 凍結案 1-1-7)
  href?: string; // renderLink injects router Link (FE1 stays router-free)
  badgeCount?: number;
  children?: SidebarItem[];
}
export interface SidebarProps extends TestableProps {
  items: SidebarItem[];
  activeId?: string;
  renderLink?: (item: SidebarItem, node: ReactNode) => ReactNode;
  collapsed?: boolean;
}

export interface PageHeaderProps extends TestableProps {
  // ReactNode (not just string) so composers can supply a rich title — e.g. FE2's
  // brand lockup (bold "DevHub" home link + a small muted account email). Still
  // rendered inside the <h1>, so plain strings keep working unchanged.
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
}

export interface StackProps extends TestableProps {
  direction?: "row" | "column"; // default "column"
  gap?: keyof import("@dub/tokens").DubTokens["space"];
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  children: ReactNode;
}

export interface GridProps extends TestableProps {
  columns?: number; // default 12
  gap?: keyof import("@dub/tokens").DubTokens["space"];
  children: ReactNode;
}

export interface CardProps extends TestableProps {
  header?: ReactNode;
  footer?: ReactNode;
  padded?: boolean; // default true
  children: ReactNode;
}

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}
export interface TabsProps extends TestableProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
}

// SegmentedControl — a row of mutually-exclusive options (segmented / pill / tab
// strip) with a highlight that slides under the selected one. Use this instead of
// hand-rolling `role="tablist"` + active-class button strips (FRONTEND_GUIDE §4).
// `V` is the value union, so `value` / `onChange` stay type-safe per call site.
export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: IconName; // optional leading icon (decorative)
  disabled?: boolean;
  testId?: string; // data-testid on this segment's button
  // When set, the segment declares it controls a disclosure/panel element: the
  // button gets `aria-controls={controls}` and reflects `aria-expanded`. Omit for
  // pure tab semantics (aria-selected only).
  controls?: string;
}
export interface SegmentedControlProps<V extends string = string> extends TestableProps {
  options: SegmentedOption<V>[];
  // Controlled selection. Provide `value` + `onChange` to control; otherwise the
  // control is uncontrolled and seeds from `defaultValue` (or the first enabled
  // option, so the strip is never blank on mount).
  value?: V | null;
  defaultValue?: V;
  onChange?: (value: V) => void;
  caption?: ReactNode; // label rendered above the strip
  captionTestId?: string; // data-testid on the caption element
  size?: Size; // default "md"
  "aria-label"?: string; // labels the tablist (recommended when no caption)
  className?: string; // extra class on the tablist (composition escape hatch)
}

export interface DividerProps extends TestableProps {
  orientation?: "horizontal" | "vertical";
}

export interface EmptyStateProps extends TestableProps {
  title: string;
  description?: string;
  icon?: IconName;
  action?: ReactNode;
}

// The only backend-shaped contract FE1 knows: a display projection of @dub/errors,
// produced by FE2 api-client `toDisplayableError` (凍結案 1-4-4).
export interface DisplayableError {
  code: string; // e.g. "FORBIDDEN", "NOT_FOUND"
  message: string; // human-readable, already localized by caller
  correlationId?: string; // テーマ3裁定: wire field=correlationId, header=x-dub-request-id
}
export interface ErrorStateProps extends TestableProps {
  error: DisplayableError;
  onRetry?: () => void;
}

export interface SkeletonLoaderProps extends TestableProps {
  lines?: number; // default 3
  width?: string;
}

// Skeleton family (FE1 §5 loading principle). A loading UI MUST render a
// skeleton, never a bare blank, so the user can tell "loading" from "empty".
export type SkeletonVariant = "text" | "circle" | "rect";
export type SkeletonAnimation = "shimmer" | "pulse" | "none";

/** A single placeholder block. Presentational (aria-hidden); wrap groups in a
 *  composite or a role="status" region so loading is announced once. */
export interface SkeletonProps extends TestableProps {
  variant?: SkeletonVariant; // default "text"
  width?: string | number; // number = px
  height?: string | number; // number = px
  radius?: string; // override border-radius (else per-variant default)
  animation?: SkeletonAnimation; // default "shimmer"
}

/** Placeholder for a loading list: `rows` line rows, optional leading avatar. */
export interface SkeletonListProps extends TestableProps {
  rows?: number; // default 3
  avatar?: boolean; // default false
  animation?: SkeletonAnimation;
}

/** Placeholder for a loading table: optional header + `rows` × `columns` cells. */
export interface SkeletonTableProps extends TestableProps {
  rows?: number; // default 5
  columns?: number; // default 4
  header?: boolean; // default true
  animation?: SkeletonAnimation;
}

/** Placeholder for a loading card: optional media block + title + `lines`. */
export interface SkeletonCardProps extends TestableProps {
  media?: boolean; // default false
  lines?: number; // default 2
  animation?: SkeletonAnimation;
}

// Rate-limit banner (FE1 §6 states family). Domain-agnostic: the consumer supplies the
// label + the backend-derived state (mail-gateway GET /internal/status → rateLimit).
// Renders nothing when `active` is false, so a surface can mount it unconditionally.
export interface RateLimitNoticeProps extends TestableProps {
  serviceLabel: string; // e.g. "メール送信API"
  active: boolean; // false => renders nothing
  recoversAt?: string | null; // ISO8601 recovery estimate (rateLimit.recoversAt)
  now?: number; // injectable clock (ms) for tests; default Date.now()
  tone?: BadgeTone; // default "warning"
}

// ── Timeline / Gantt (FE1 data-viz family). The data-viz primitive the design
// system was missing: FE4 previously hand-rolled the Gantt as raw SVG + a local
// gantt-layout module. This primitive is data-agnostic — consumers convert their
// DTO to numeric epoch-ms rows (FE1 never imports @dub/types). Bar geometry,
// timeline ticks, and dependency segments are computed inside from these props;
// the pure math is exported (see `timeline-geometry`) for drag/quantization use.
export type TimelineScale = "day" | "week" | "month";

export interface TimelineRow {
  id: string;
  label: ReactNode;
  /** epoch ms. null keeps the row listed with no bar (unscheduled task — FE4 §7). */
  startMs: number | null;
  endMs: number | null;
  progressPercent?: number; // 0–100, clamped; drives the progress overlay
}

export interface TimelineDependency {
  id: string;
  fromId: string;
  toId: string;
  // FS violation (successor starts before predecessor finishes +lag). The consumer
  // owns the date math and passes the flag; the primitive only draws the stroke.
  violated?: boolean;
}

export interface TimelineProps extends TestableProps {
  rows: TimelineRow[];
  dependencies?: TimelineDependency[];
  scale?: TimelineScale; // default "week"
  onScaleChange?: (scale: TimelineScale) => void; // renders a scale switcher when set
  rowHeight?: number; // px, default 28
  minBarWidth?: number; // px, default 4 (same-day bar stays clickable)
  truncated?: boolean; // renders a banner above the grid (e.g. gantt row cap §8-8)
  truncatedLabel?: ReactNode;
  onRowClick?: (id: string) => void;
  selectedRowId?: string | null;
  emptyState?: ReactNode; // shown when no rows have dates
}

// ── Chat message list (FE1 chat family). The chat primitive the design system was
// missing: FE6 previously hand-rolled the timeline + message rows in local CSS.
// Data-agnostic — `body` is a pre-rendered ReactNode (the consumer owns Md-subset /
// mention rendering) and auth-gated actions are injected via render props, so FE1
// stays domain-free. Day dividers, an unread divider, reactions, and pending/failed
// send states are handled here.
export type ChatMessageState = "sent" | "pending" | "failed";

export interface ChatReaction {
  emoji: string;
  count: number;
  mine?: boolean; // highlights the pill when the current user reacted
}

export interface ChatMessage {
  id: string;
  authorName: ReactNode;
  body: ReactNode; // already-rendered (mentions/code resolved by the consumer)
  timeLabel: ReactNode; // e.g. "13:42"
  dayKey?: string; // groups messages; a date divider shows when it changes
  dayLabel?: ReactNode; // divider label (defaults to dayKey)
  edited?: boolean;
  deleted?: boolean; // renders a redacted tombstone instead of the body
  deletedLabel?: ReactNode; // default "このメッセージは削除されました"
  reactions?: ChatReaction[];
  state?: ChatMessageState; // default "sent"; "pending"/"failed" style the row
}

export interface MessageListProps extends TestableProps {
  messages: ChatMessage[];
  unreadBeforeId?: string | null; // renders an unread divider before this message
  unreadLabel?: ReactNode; // default "ここから未読"
  hasOlder?: boolean; // shows a "load older" affordance (no auto-firing)
  onLoadOlder?: () => void;
  loadOlderLabel?: ReactNode; // default "以前のメッセージを読み込む"
  onToggleReaction?: (messageId: string, emoji: string) => void;
  renderActions?: (message: ChatMessage) => ReactNode; // edit/delete slot (consumer gates auth)
  renderFailedActions?: (message: ChatMessage) => ReactNode; // resend/discard slot
  emptyState?: ReactNode;
}
