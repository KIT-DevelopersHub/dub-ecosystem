// FormError — layer ② composite. The `role="alert"` form-level error paragraph
// every dialog rebuilt as an inline `formErrorStyle` const. Renders nothing when
// empty so callers can pass a possibly-null message unconditionally.
import type { ReactNode } from "react";
import styles from "./FormError.module.css";

export interface FormErrorProps {
  children?: ReactNode;
  testId?: string;
}

export function FormError({ children, testId }: FormErrorProps): JSX.Element | null {
  if (children == null || children === "" || children === false) return null;
  return (
    <p className={styles.error} role="alert" data-testid={testId}>
      {children}
    </p>
  );
}
