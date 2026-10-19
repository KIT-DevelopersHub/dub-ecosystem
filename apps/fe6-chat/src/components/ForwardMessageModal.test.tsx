import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ForwardMessageModal } from "./ForwardMessageModal";

describe("メッセージを転送する", () => {
  it("picks a destination by search, previews the card and posts the quote with a link back", async () => {
    const onForward = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ForwardMessageModal
        sourceChannelName="#general"
        channels={[
          { id: "chn_dev", label: "#dev", archived: false },
          { id: "chn_design", label: "#design", archived: false },
          { id: "chn_old", label: "#dev-old", archived: true },
        ]}
        authorName="Bob"
        preview="会場の下見"
        link="https://x.dev/chat/channels/chn_general?message=m1"
        onClose={onClose}
        onForward={onForward}
      />,
    );
    expect(screen.getByTestId("fe6-forward-preview-card")).toHaveTextContent("#general に投稿");
    expect(screen.getByTestId("fe6-forward-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("fe6-forward-target"), { target: { value: "#dev" } });
    const options = screen.getAllByTestId("fe6-forward-option");
    expect(options.map((o) => o.textContent)).toEqual(["#dev"]); // archived excluded
    fireEvent.click(options[0]!);
    expect(screen.getByTestId("fe6-forward-picked")).toHaveTextContent("#dev");
    fireEvent.change(screen.getByTestId("fe6-forward-comment"), { target: { value: "共有です" } });
    fireEvent.click(screen.getByTestId("fe6-forward-submit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onForward).toHaveBeenCalledWith(
      "chn_dev",
      "共有です\n\n> 会場の下見\n> — Bob · #general から転送 https://x.dev/chat/channels/chn_general?message=m1",
    );
  });
});
