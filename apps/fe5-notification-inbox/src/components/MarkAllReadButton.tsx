// MarkAllReadButton — marks all read, carrying the active type filter through to
// ReadAllRequest.type (FE5 §2-2, test 7).

import type { ReactNode } from "react";
import { Button } from "../contracts/fe1";

export function MarkAllReadButton(props: {
  onClick: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      onClick={props.onClick}
      disabled={props.disabled}
      testId="fe5-inbox-markall"
      aria-label="Mark all as read"
    >
      Mark all as read
    </Button>
  );
}
