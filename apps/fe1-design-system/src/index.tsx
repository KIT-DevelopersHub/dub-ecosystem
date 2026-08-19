// @dub/ui — DevHub FE1 design system public entry.
// Leaf front-end package: no backend, no router, no data. Consumers (FE2〜FE7)
// import components + types here; FE8 uses @dub/tokens/css only.

// Contract types (frozen — FE1 §2-3)
export type {
  Size,
  Variant,
  TestableProps,
  IconName,
  IconProps,
  ButtonProps,
  IconButtonProps,
  BadgeTone,
  BadgeProps,
  TagProps,
  AvatarProps,
  SpinnerProps,
  TooltipProps,
  PopoverProps,
  MenuItem,
  MenuProps,
  FormProps,
  FormFieldProps,
  TextFieldProps,
  TextareaProps,
  SelectOption,
  SelectProps,
  CheckboxProps,
  RadioProps,
  SwitchProps,
  DatePickerProps,
  ColumnDef,
  SortState,
  DataTableProps,
  PaginationProps,
  LoadMoreProps,
  ModalProps,
  ConfirmDialogProps,
  ErrorDialogDetail,
  ErrorDialogProps,
  DrawerProps,
  ToastKind,
  ToastOptions,
  ThemeName,
  ThemeProviderProps,
  AppShellProps,
  AppLauncherItem,
  AppLauncherProps,
  SidebarItem,
  SidebarProps,
  PageHeaderProps,
  StackProps,
  GridProps,
  CardProps,
  TabItem,
  TabsProps,
  SegmentedOption,
  SegmentedControlProps,
  DividerProps,
  EmptyStateProps,
  DisplayableError,
  ErrorStateProps,
  SkeletonLoaderProps,
  SkeletonVariant,
  SkeletonAnimation,
  SkeletonProps,
  SkeletonListProps,
  SkeletonTableProps,
  SkeletonCardProps,
  RateLimitNoticeProps,
  TimelineScale,
  TimelineRow,
  TimelineDependency,
  TimelineProps,
  ChatMessageState,
  ChatReaction,
  ChatMessage,
  MessageListProps,
} from "./types";

// Components
export { Icon } from "./components/Icon";
export { Spinner } from "./components/Spinner";
export { Button, IconButton } from "./components/Button";
export { Badge, Tag, Avatar } from "./components/Display";
export { Tooltip, Popover } from "./components/Tooltip";
export { Menu } from "./components/Menu";
export { Form, FormField } from "./components/Form";
export {
  TextField,
  Textarea,
  Select,
  Checkbox,
  Radio,
  Switch,
  DatePicker,
} from "./components/Inputs";
export { DataTable } from "./components/DataTable";
export { Pagination, LoadMore } from "./components/Pagination";
export { Modal, ConfirmDialog, Drawer, ErrorDialog } from "./components/Modal";
export { ToastProvider, useToast } from "./components/Toast";
export { ThemeProvider } from "./components/ThemeProvider";
export { AppShell, PageHeader, Stack, Grid, Card, Divider } from "./components/Layout";
export { AppLauncher } from "./components/AppLauncher";
export { Sidebar } from "./components/Sidebar";
export { Tabs } from "./components/Tabs";
export { SegmentedControl } from "./components/SegmentedControl";
export { EmptyState, ErrorState, SkeletonLoader } from "./components/States";
export { Skeleton, SkeletonList, SkeletonTable, SkeletonCard } from "./components/Skeleton";
export { RateLimitNotice, formatRecoveryText } from "./components/RateLimitNotice";
export { Timeline } from "./components/Timeline";
export { MessageList } from "./components/MessageList";
// Drag-to-reorder primitive (floating overlay + neighbour reflow + keyboard a11y).
// Every reorder UI should use this — see FRONTEND_GUIDE「並べ替え UI」.
export { SortableList } from "./components/SortableList";
export type {
  SortableListProps,
  SortableItemContext,
  SortableReorderEvent,
  SortableDragHandleProps,
} from "./components/SortableList";

// Timeline geometry helpers (pure, data-agnostic — consumers reuse for D&D/ticks).
export {
  TIMELINE_PX_PER_DAY,
  computeTimelineBounds,
  timelineBars,
  timelineTicks,
  timelineDependencySegments,
  pxToDayDelta,
  shiftMsByDays,
} from "./utils/timeline-geometry";
export type {
  TimelineBounds,
  TimelineBar,
  TimelineBarsOptions,
  TimelineTick,
  TimelineSegment,
} from "./utils/timeline-geometry";

// Icon registry (also available at @dub/ui/icons)
export { iconRegistry } from "./icons";

// Keyboard primitives — IME-safe Enter-to-submit (shared by every text field).
export { isImeComposing, isSubmitEnter, useEnterToSubmit } from "./utils/keyboard";
export type { SubmitEnterOptions, EnterToSubmitHandlers } from "./utils/keyboard";
