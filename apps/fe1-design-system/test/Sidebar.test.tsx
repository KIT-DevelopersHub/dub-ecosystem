import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import type { SidebarItem } from "../src/types";

const items: SidebarItem[] = [
  { id: "home", label: "ホーム", icon: "home", href: "/" },
  { id: "notif", label: "通知", icon: "bell", href: "/notif", badgeCount: 3 },
];

describe("Sidebar", () => {
  it("marks the active item with aria-current", () => {
    render(<Sidebar items={items} activeId="notif" />);
    const active = screen.getByText("通知").closest("[aria-current]");
    expect(active).toHaveAttribute("aria-current", "page");
  });

  it("renders badgeCount", () => {
    render(<Sidebar items={items} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("resolves IconName to an svg icon", () => {
    const { container } = render(<Sidebar items={items} />);
    expect(container.querySelector('svg[data-icon="home"]')).not.toBeNull();
    expect(container.querySelector('svg[data-icon="bell"]')).not.toBeNull();
  });

  it("injects a custom link node via renderLink", () => {
    render(
      <Sidebar
        items={items}
        renderLink={(item, node) => <div data-router-link={item.id}>{node}</div>}
      />,
    );
    expect(screen.getByText("ホーム").closest("[data-router-link]")).toHaveAttribute(
      "data-router-link",
      "home",
    );
  });

  it("hides labels when collapsed", () => {
    render(<Sidebar items={items} collapsed />);
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
  });
});
