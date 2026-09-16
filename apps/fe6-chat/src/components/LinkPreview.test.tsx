import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { MockChatClient } from "../api/mock-client";
import { LinkPreviews, resetLinkPreviewCache, LINK_PREVIEW_MARKER } from "./LinkPreview";
import { MessageBody } from "./MessageBody";

function runtime(): ChatRuntime {
  return {
    api: new MockChatClient({ currentUserId: "usr_me" }),
    can: () => true,
    currentUserId: "usr_me",
    createRealtimeClient: () => {
      throw new Error("unused");
    },
  };
}

describe("LinkPreviews", () => {
  beforeEach(() => resetLinkPreviewCache());

  it("renders a card (site / title / description / image) for a known host, opening in a new tab", async () => {
    render(
      <ChatRuntimeProvider value={runtime()}>
        <LinkPreviews body="see https://github.com/KIT-DevelopersHub/dub-ecosystem now" />
      </ChatRuntimeProvider>,
    );
    const card = await screen.findByTestId("fe6-link-preview");
    expect(card).toHaveAttribute("href", "https://github.com/KIT-DevelopersHub/dub-ecosystem");
    expect(card).toHaveAttribute("target", "_blank");
    expect(card.getAttribute("rel")).toContain("noopener");
    expect(card).toHaveTextContent("GitHub");
    expect(card.querySelector("img")).not.toBeNull();
    expect(screen.getByTestId("fe6-link-previews")).toHaveAttribute("data-marker", LINK_PREVIEW_MARKER);
  });

  it("renders nothing for unknown hosts (no OGP) and without a runtime", async () => {
    const { rerender } = render(
      <ChatRuntimeProvider value={runtime()}>
        <LinkPreviews body="https://no-ogp.invalid/x" />
      </ChatRuntimeProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("fe6-link-previews")).toBeNull());
    rerender(<LinkPreviews body="https://github.com/x" />);
    await waitFor(() => expect(screen.queryByTestId("fe6-link-previews")).toBeNull());
  });

  it("caps at two cards", async () => {
    render(
      <ChatRuntimeProvider value={runtime()}>
        <LinkPreviews body="https://github.com/a https://zenn.dev/b https://qiita.com/c" />
      </ChatRuntimeProvider>,
    );
    await screen.findAllByTestId("fe6-link-preview");
    expect(screen.getAllByTestId("fe6-link-preview")).toHaveLength(2);
  });
});

describe("MessageBody bare URL autolink", () => {
  it("renders a bare URL as a safe anchor without HTML injection", () => {
    // "<" ends the URL run (BARE_URL_RE), so the markup-looking tail is plain text.
    const { container } = render(<MessageBody body={'go https://ex.com/p?q=1 <b>x</b> now'} />);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("href", "https://ex.com/p?q=1");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector("b")).toBeNull(); // rendered as text, not markup
    expect(container).toHaveTextContent("<b>x</b>");
  });

  it("never emits a javascript: href even via a markdown link", () => {
    render(<MessageBody body={"[x](javascript:alert(1)) https://ok.dev"} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://ok.dev");
  });
});
