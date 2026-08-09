import type { CSSProperties } from "react";
import { toCssVarName } from "@dub/tokens";
import type {
  AppShellProps,
  CardProps,
  DividerProps,
  GridProps,
  PageHeaderProps,
  StackProps,
} from "../types";
import styles from "./Layout.module.css";
import { cx } from "../utils/cx";

const JUSTIFY: Record<NonNullable<StackProps["justify"]>, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
};
const ALIGN: Record<NonNullable<StackProps["align"]>, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

export function Stack({
  direction = "column",
  gap = 4,
  align,
  justify,
  wrap,
  testId,
  children,
}: StackProps) {
  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction,
    gap: toCssVarName(`space.${String(gap)}`),
    alignItems: align ? ALIGN[align] : undefined,
    justifyContent: justify ? JUSTIFY[justify] : undefined,
    flexWrap: wrap ? "wrap" : undefined,
  };
  return (
    <div style={style} data-testid={testId}>
      {children}
    </div>
  );
}

export function Grid({ columns = 12, gap = 4, testId, children }: GridProps) {
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: toCssVarName(`space.${String(gap)}`),
  };
  return (
    <div style={style} data-testid={testId}>
      {children}
    </div>
  );
}

export function Card({ header, footer, padded = true, testId, children }: CardProps) {
  return (
    <section className={cx(styles.card)} data-testid={testId}>
      {header && <header className={cx(styles.cardHeader)}>{header}</header>}
      <div className={cx(padded && styles.cardBody)}>{children}</div>
      {footer && <footer className={cx(styles.cardFooter)}>{footer}</footer>}
    </section>
  );
}

export function Divider({ orientation = "horizontal", testId }: DividerProps) {
  return (
    <hr
      className={cx(styles.divider)}
      data-orientation={orientation}
      data-testid={testId}
      aria-orientation={orientation}
    />
  );
}

export function PageHeader({ title, description, actions, breadcrumbs, testId }: PageHeaderProps) {
  return (
    <header className={cx(styles.pageHeader)} data-testid={testId}>
      {breadcrumbs && <div className={cx(styles.breadcrumbs)}>{breadcrumbs}</div>}
      <div className={cx(styles.pageHeaderRow)}>
        <div>
          <h1 className={cx(styles.pageTitle)}>{title}</h1>
          {description && <p className={cx(styles.pageDescription)}>{description}</p>}
        </div>
        {actions && <div className={cx(styles.pageActions)}>{actions}</div>}
      </div>
    </header>
  );
}

/** Visual shell (凍結案 1-4-1): FE1 owns the chrome; FE2 AppShellLayout wires nav/auth. */
export function AppShell({ sidebar, header, testId, children }: AppShellProps) {
  return (
    <div className={cx(styles.shell)} data-testid={testId}>
      <aside className={cx(styles.shellSidebar)}>{sidebar}</aside>
      <div className={cx(styles.shellMain)}>
        {header && <div className={cx(styles.shellHeader)}>{header}</div>}
        <main className={cx(styles.shellContent)}>{children}</main>
      </div>
    </div>
  );
}
