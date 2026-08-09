// FE1 (design system) contract surface + minimal stub implementations.
//
// FE1 is not yet built. FE5 must code against FE1's *public component I/F* and
// the closed `IconName` union. These stubs are intentionally unstyled/minimal —
// they exist so FE5 compiles, renders, and is testable. When FE1 ships, this
// file is replaced by `import { Button, Badge, ... } from "@dub/ui"` and
// `import type { IconName } from "@dub/ui/icons"` with no call-site changes.

import type {
  ButtonHTMLAttributes,
  ReactNode,
  ChangeEventHandler,
  KeyboardEventHandler,
} from "react";

// ---- IconName: FE1's closed union (single source of icon-name resolution) ----
// Subset sufficient for FE5's notification type dictionary + chrome.
export type IconName =
  | "bell"
  | "bell-off"
  | "check"
  | "check-all"
  | "inbox"
  | "task"
  | "calendar"
  | "megaphone"
  | "info"
  | "alert"
  | "settings"
  | "chevron-down"
  | "external-link"
  | "refresh";

export interface WithTestId {
  testId?: string; // FE1 `testId` prop -> data-testid
}

// ---- Icon ----
export function Icon(props: { name: IconName; label?: string } & WithTestId): ReactNode {
  return (
    <span
      role="img"
      aria-label={props.label ?? props.name}
      data-icon={props.name}
      data-testid={props.testId}
    />
  );
}

// ---- Button ----
export function Button(
  props: {
    children: ReactNode;
    variant?: "primary" | "secondary" | "ghost" | "danger";
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
  } & WithTestId &
    Pick<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-label">,
): ReactNode {
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled || props.loading}
      aria-label={props["aria-label"]}
      data-variant={props.variant ?? "primary"}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

export function IconButton(
  props: { icon: IconName; onClick?: () => void } & WithTestId &
    Pick<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-expanded">,
): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props["aria-label"]}
      aria-expanded={props["aria-expanded"]}
      data-testid={props.testId}
    >
      <Icon name={props.icon} />
    </button>
  );
}

// ---- Badge (count) ----
export function Badge(
  props: { count: number; max?: number; "aria-label"?: string } & WithTestId,
): ReactNode {
  if (props.count <= 0) return null; // 0 -> no badge (design case 9)
  const max = props.max ?? 99;
  const text = props.count > max ? `${max}+` : String(props.count);
  return (
    <span
      data-testid={props.testId}
      aria-label={props["aria-label"] ?? `${props.count} unread`}
    >
      {text}
    </span>
  );
}

// ---- Switch (toggle) ----
export function Switch(
  props: {
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    label: string; // a11y label (required)
  } & WithTestId,
): ReactNode {
  const onChange: ChangeEventHandler<HTMLInputElement> = (e) =>
    props.onChange(e.currentTarget.checked);
  return (
    <input
      type="checkbox"
      role="switch"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={onChange}
      data-testid={props.testId}
    />
  );
}

// ---- Tabs (segmented control) ----
export interface TabOption {
  value: string;
  label: string;
}
export function Tabs(
  props: {
    options: TabOption[];
    value: string;
    onChange: (value: string) => void;
    "aria-label"?: string;
  } & WithTestId,
): ReactNode {
  return (
    <div role="tablist" aria-label={props["aria-label"]} data-testid={props.testId}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- LoadMore ----
export function LoadMore(
  props: { onClick: () => void; loading?: boolean; disabled?: boolean } & WithTestId,
): ReactNode {
  return (
    <Button
      variant="secondary"
      onClick={props.onClick}
      disabled={props.disabled}
      loading={props.loading}
      testId={props.testId}
    >
      {props.loading ? "Loading…" : "Load more"}
    </Button>
  );
}

// ---- SkeletonLoader / Spinner ----
export function SkeletonLoader(props: { rows?: number } & WithTestId): ReactNode {
  const rows = props.rows ?? 3;
  return (
    <div aria-hidden="true" data-testid={props.testId}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} data-skeleton-row />
      ))}
    </div>
  );
}
export function Spinner(props: WithTestId): ReactNode {
  return <span role="status" aria-label="Loading" data-testid={props.testId} />;
}

// ---- EmptyState ----
export function EmptyState(
  props: {
    icon?: IconName;
    title: string;
    description?: string;
    action?: { label: string; onClick: () => void };
  } & WithTestId,
): ReactNode {
  return (
    <div data-testid={props.testId}>
      {props.icon ? <Icon name={props.icon} /> : null}
      <p>{props.title}</p>
      {props.description ? <p>{props.description}</p> : null}
      {props.action ? (
        <Button onClick={props.action.onClick}>{props.action.label}</Button>
      ) : null}
    </div>
  );
}

// ---- Layout primitives ----
export function PageHeader(
  props: { title: string; actions?: ReactNode } & WithTestId,
): ReactNode {
  return (
    <header data-testid={props.testId}>
      <h1>{props.title}</h1>
      {props.actions}
    </header>
  );
}
export function Stack(props: { children: ReactNode; gap?: number } & WithTestId): ReactNode {
  return (
    <div data-testid={props.testId} data-gap={props.gap}>
      {props.children}
    </div>
  );
}
export function Card(props: { children: ReactNode } & WithTestId): ReactNode {
  return <section data-testid={props.testId}>{props.children}</section>;
}

// ---- Popover (bell dropdown) ----
export function Popover(
  props: {
    open: boolean;
    trigger: ReactNode;
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  } & WithTestId,
): ReactNode {
  return (
    <div data-testid={props.testId} onKeyDown={props.onKeyDown}>
      {props.trigger}
      {props.open ? <div role="menu">{props.children}</div> : null}
    </div>
  );
}

// ---- Table ----
export function Table(
  props: { head: ReactNode; children: ReactNode; caption?: string } & WithTestId,
): ReactNode {
  return (
    <table data-testid={props.testId}>
      {props.caption ? <caption>{props.caption}</caption> : null}
      <thead>{props.head}</thead>
      <tbody>{props.children}</tbody>
    </table>
  );
}

// ---- Tooltip ----
export function Tooltip(props: { text: string; children: ReactNode }): ReactNode {
  return <span title={props.text}>{props.children}</span>;
}

// ---- Select ----
export function Select(
  props: {
    options: TabOption[];
    value: string;
    onChange: (value: string) => void;
    "aria-label": string;
  } & WithTestId,
): ReactNode {
  return (
    <select
      value={props.value}
      aria-label={props["aria-label"]}
      data-testid={props.testId}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
