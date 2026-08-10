// MarkAllReadButton — marks all read, carrying the active type filter through to
// ReadAllRequest.type (FE5 §2-2, test 7).

import type { ReactNode } from "react";
import { Button } from "@dub/ui";

export function MarkAllReadButton(props: {
  onClick: () => void;
  disabled?: boolean;
}): ReactNode {
  // The visible label ("Mark all as read") is the button's accessible name;
  // @dub/ui Button takes no separate aria-label (see ButtonProps).
  return (
    <Button
      variant="ghost"
      onClick={props.onClick}
      disabled={props.disabled}
      testId="fe5-inbox-markall"
    >
      Mark all as read
    </Button>
  );
}
