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
  | "archive";

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
  sortable?: boolean;
  align?: "left" | "center" | "right";
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
  sidebar: ReactNode;
  header?: ReactNode;
  children: ReactNode; // main content
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
  title: string;
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
