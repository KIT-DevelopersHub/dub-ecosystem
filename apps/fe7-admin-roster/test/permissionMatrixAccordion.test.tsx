// @vitest-environment jsdom
// P26: fe7 RoleListPage — per-domain accordion inside the permission matrix.
// (The role STRIP itself moved from a vertical accordion to tabs long ago — see
// RoleListPage.tsx/.module.css — so this covers where an instant-appear/disappear
// disclosure still existed: each permission domain group.)
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { identity } from "@dub/types";
import { PermissionMatrix } from "../src/components/PermissionMatrix";

const catalog = [...identity.PERMISSION_CATALOG].filter((e) => e.domain !== "app");

describe("PermissionMatrix — per-domain accordion (P26)", () => {
  it("starts every domain group open (unchanged default view)", () => {
    render(<PermissionMatrix catalog={catalog} selected={[]} onChange={() => {}} />);
    expect(screen.getByTestId("fe7-matrix-grid-event")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-matrix-toggle-event")).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses a domain group on toggle click; the grid unmounts after the height transition", async () => {
    const user = userEvent.setup();
    render(<PermissionMatrix catalog={catalog} selected={[]} onChange={() => {}} />);
    const toggle = screen.getByTestId("fe7-matrix-toggle-event");

    await user.click(toggle);

    // aria-expanded flips immediately (accessible state is never delayed)...
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // ...but the grid itself unmounts only once the closing transition finishes.
    await waitFor(() => expect(screen.queryByTestId("fe7-matrix-grid-event")).not.toBeInTheDocument());
  });

  it("reopens a collapsed domain group instantly (no delay on the way back in)", async () => {
    const user = userEvent.setup();
    render(<PermissionMatrix catalog={catalog} selected={[]} onChange={() => {}} />);
    const toggle = screen.getByTestId("fe7-matrix-toggle-event");

    await user.click(toggle);
    await waitFor(() => expect(screen.queryByTestId("fe7-matrix-grid-event")).not.toBeInTheDocument());

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("fe7-matrix-grid-event")).toBeInTheDocument();
  });

  it("opens/closes each domain group independently — not a single-open accordion", async () => {
    const user = userEvent.setup();
    render(<PermissionMatrix catalog={catalog} selected={[]} onChange={() => {}} />);

    await user.click(screen.getByTestId("fe7-matrix-toggle-event"));
    await waitFor(() => expect(screen.queryByTestId("fe7-matrix-grid-event")).not.toBeInTheDocument());

    // a different domain group is untouched and stays open the whole time.
    expect(screen.getByTestId("fe7-matrix-grid-mail")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-matrix-toggle-mail")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the collapse toggle and the domain select-all checkbox independent", async () => {
    const user = userEvent.setup();
    const onChange = () => {};
    render(<PermissionMatrix catalog={catalog} selected={[]} onChange={onChange} />);

    // Collapsing a domain must not touch its "select all" checkbox state.
    const selectAll = screen.getByTestId("fe7-matrix-domain-event") as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
    await user.click(screen.getByTestId("fe7-matrix-toggle-event"));
    expect(selectAll.checked).toBe(false);
  });
});
