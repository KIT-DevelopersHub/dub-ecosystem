// DialogActions — layer ② composite. The footer button row every dialog rebuilt
// as an inline `actionsRow` const. Compose @dub/ui Buttons as children.
import type { ReactNode } from "react";
import styles from "./DialogActions.module.css";

export interface DialogActionsProps {
  children: ReactNode;
  /** Horizontal alignment of the buttons. Default "end" (right-aligned). */
  align?: "end" | "between" | "center";
  testId?: string;
}

export function DialogActions({ children, align = "end", testId }: DialogActionsProps): JSX.Element {
  return (
    <div className={styles.row} data-align={align} data-testid={testId}>
      {children}
    </div>
  );
}
