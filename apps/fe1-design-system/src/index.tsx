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
  DrawerProps,
  ToastKind,
  ToastOptions,
  ThemeName,
  ThemeProviderProps,
  AppShellProps,
  SidebarItem,
  SidebarProps,
  PageHeaderProps,
  StackProps,
  GridProps,
  CardProps,
  TabItem,
  TabsProps,
  DividerProps,
  EmptyStateProps,
  DisplayableError,
  ErrorStateProps,
  SkeletonLoaderProps,
  RateLimitNoticeProps,
} from "./types";

// Components
export { Icon } from "./components/Icon";
export { Spinner } from "./components/Spinner";
export { Button, IconButton } from "./components/Button";
export { Badge, Tag, Avatar } from "./components/Display";
export { Tooltip, Popover } from "./components/Tooltip";
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
export { Modal, ConfirmDialog, Drawer } from "./components/Modal";
export { ToastProvider, useToast } from "./components/Toast";
export { ThemeProvider } from "./components/ThemeProvider";
export { AppShell, PageHeader, Stack, Grid, Card, Divider } from "./components/Layout";
export { Sidebar } from "./components/Sidebar";
export { Tabs } from "./components/Tabs";
export { EmptyState, ErrorState, SkeletonLoader } from "./components/States";
export { RateLimitNotice, formatRecoveryText } from "./components/RateLimitNotice";

// Icon registry (also available at @dub/ui/icons)
export { iconRegistry } from "./icons";
