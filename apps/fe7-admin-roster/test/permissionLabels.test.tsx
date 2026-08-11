// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { identity } from "@dub/types";
import { PermissionMatrix } from "../src/components/PermissionMatrix";
import { domainLabel, permissionLabel, permissionDescription } from "../src/lib/permissionLabels";

const catalog = [...identity.PERMISSION_CATALOG];

describe("permissionLabels — localization map", () => {
  it("maps every catalog domain to a Japanese group heading", () => {
    const domains = [...new Set(catalog.map((e) => e.domain))];
    for (const d of domains) {
      const label = domainLabel(d);
      expect(label).not.toBe(d); // localized, not the raw english domain
      expect(label).toMatch(/[぀-ヿ一-龯]|GitHub|Drive|Webhook/); // ja text (or proper noun)
    }
  });

  it("maps every catalog key to a Japanese label + description", () => {
    for (const e of catalog) {
      expect(permissionLabel(e.key, e.name)).not.toBe(e.name); // localized away from english
      expect(permissionDescription(e.key, e.description)).not.toBe(e.description);
    }
  });

  it("falls back to catalog english text for an unknown key/domain", () => {
    expect(domainLabel("unknown-domain")).toBe("unknown-domain");
    expect(permissionLabel("unknown:key", "English Name")).toBe("English Name");
    expect(permissionDescription("unknown:key", "English desc")).toBe("English desc");
  });
});

describe("PermissionMatrix — Japanese, grouped, on/off legible", () => {
  it("renders Japanese group headings and per-key labels with the raw key as a hint", () => {
    render(<PermissionMatrix catalog={catalog} selected={["mail:read"]} onChange={() => {}} />);
    // group heading localized (メール)
    expect(screen.getByText("メール")).toBeInTheDocument();
    // key label localized, raw key still visible as a hint
    expect(screen.getByText("メールの閲覧")).toBeInTheDocument();
    expect(screen.getByText("mail:read")).toBeInTheDocument();
  });

  it("shows an オン/オフ state pill per permission reflecting the selection", () => {
    render(<PermissionMatrix catalog={catalog} selected={["mail:read"]} onChange={() => {}} />);
    expect(screen.getByTestId("fe7-matrix-state-mail:read")).toHaveTextContent("オン");
    expect(screen.getByTestId("fe7-matrix-state-mail:send")).toHaveTextContent("オフ");
  });

  it("shows an N / M 有効 count on each group header", () => {
    render(<PermissionMatrix catalog={catalog} selected={["mail:read"]} onChange={() => {}} />);
    // mail domain has 3 keys (send/read/admin), 1 selected
    expect(screen.getByTestId("fe7-matrix-count-mail")).toHaveTextContent("1 / 3 有効");
  });

  it("keeps checkbox testids + semantics intact (behavior-preserving)", () => {
    render(<PermissionMatrix catalog={catalog} selected={["mail:read"]} disabled onChange={() => {}} />);
    const box = screen.getByTestId("fe7-matrix-key-mail:read") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });
});
