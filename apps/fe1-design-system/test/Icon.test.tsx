import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Icon } from "../src/components/Icon";
import { iconRegistry } from "../src/icons";
import type { IconName } from "../src/types";

const ALL_NAMES = Object.keys(iconRegistry) as IconName[];

describe("Icon", () => {
  it("renders every IconName in the closed union", () => {
    for (const name of ALL_NAMES) {
      const { container, unmount } = render(<Icon name={name} testId={`icon-${name}`} />);
      const svg = container.querySelector("svg");
      expect(svg, `icon ${name} should render an svg`).not.toBeNull();
      expect(svg).toHaveAttribute("data-icon", name);
      unmount();
    }
  });

  it("is aria-hidden when no label (decorative)", () => {
    const { container } = render(<Icon name="home" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role", "img");
  });

  it("is a labelled image when aria-label given", () => {
    const { container } = render(<Icon name="home" aria-label="ホーム" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "ホーム");
    expect(svg).not.toHaveAttribute("aria-hidden");
  });

  it("applies size to width/height", () => {
    const { container } = render(<Icon name="home" size="lg" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });
});
