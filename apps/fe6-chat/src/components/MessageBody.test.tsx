import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common } from "@dub/types";
import { MessageBody } from "./MessageBody";

describe("MessageBody mentions", () => {
  it("renders a resolved mention with the display name", () => {
    render(
      <MessageBody
        body="hi <@usr_a>"
        resolveUser={(id: common.UserId) => (id === "usr_a" ? { id, displayName: "佐藤 花子", avatarUrl: null } : undefined)}
      />,
    );
    expect(screen.getByText("@佐藤 花子")).toBeInTheDocument();
  });

  it("renders an unresolvable mention as 不明な人, never the raw id", () => {
    const { container } = render(<MessageBody body="hi <@usr_0000000000BKKFVE5771H9CKX3>" resolveUser={() => undefined} />);
    expect(screen.getByText("@不明な人")).toBeInTheDocument();
    expect(container.textContent).not.toContain("usr_0000000000BKKFVE5771H9CKX3");
  });
});
