// MarkAllReadButton — marks all read, carrying the active type filter through to
// ReadAllRequest.type (FE5 §2-2, test 7).

import type { ReactNode } from "react";
import { Button } from "@dub/ui";

export function MarkAllReadButton(props: {
  onClick: () => void;
  disabled?: boolean;
}): ReactNode {
  // The visible label is the accessible name (ButtonProps has no aria-label).
  // secondary = the standard outlined page action (#900); ghost read as bare text.
  return (
    <Button
      variant="secondary"
      onClick={props.onClick}
      disabled={props.disabled}
      testId="fe5-inbox-markall"
    >
      すべて既読にする
    </Button>
  );
}
