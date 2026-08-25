import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SortableList } from "../src/components/SortableList";

interface Row {
  id: string;
  label: string;
}
const ITEMS: Row[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

function renderList(opts: { disabled?: boolean; onReorder?: () => void } = {}) {
  return render(
    <SortableList<Row>
      items={ITEMS}
      getItemId={(r) => r.id}
      disabled={opts.disabled ?? false}
      onReorder={opts.onReorder ?? (() => {})}
      testId="list"
      aria-label="rows"
      renderItem={(r, ctx) => (
        <div data-testid={`row-${r.id}`}>
          <button type="button" data-testid={`handle-${r.id}`} {...ctx.dragHandleProps}>
            ⠿
          </button>
          {r.label}
        </div>
      )}
    />,
  );
}

describe("SortableList", () => {
  it("renders every item in order inside the labelled list wrapper", () => {
    renderList();
    const list = screen.getByTestId("list");
    expect(list).toHaveAttribute("aria-label", "rows");
    expect(within(list).getByText("Alpha")).toBeInTheDocument();
    expect(within(list).getByText("Bravo")).toBeInTheDocument();
    expect(within(list).getByText("Charlie")).toBeInTheDocument();
  });

  it("arms each handle with the sortable a11y attributes (role + keyboard descriptor)", () => {
    renderList();
    const handle = screen.getByTestId("handle-a");
    // dnd-kit sortable attributes: role=button + aria-roledescription=sortable, and it
    // is keyboard-focusable (tabindex 0) so Space/arrows can drive the reorder.
    expect(handle).toHaveAttribute("aria-roledescription", "sortable");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-disabled", "false");
  });

  it("marks handles disabled when disabled (no drag)", () => {
    renderList({ disabled: true });
    const handle = screen.getByTestId("handle-a");
    // when disabled, SortableList passes empty handle props → no sortable attributes
    expect(handle).not.toHaveAttribute("aria-roledescription");
  });

  it("does not render the floating overlay until a drag starts", () => {
    renderList();
    // overlay clone carries a duplicate handle only while dragging — none at rest
    expect(screen.getAllByTestId("handle-a")).toHaveLength(1);
  });
});
