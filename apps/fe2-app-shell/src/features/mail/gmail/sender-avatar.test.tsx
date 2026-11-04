// 送信者アイコン: Dub users resolve to their icon, everyone else keeps the initial; lookups
// on one screen are batched into a single request.
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MailApiProvider } from "../MailProvider.tsx";
import type { MailApi } from "../mailApi.tsx";
import { SenderAvatar } from "./SenderAvatar.tsx";

function apiWith(avatars: MailApi["avatars"]): MailApi {
  return { avatars } as unknown as MailApi;
}

describe("SenderAvatar", () => {
  it("shows a Dub user's icon and keeps the initial for others, in one batched request", async () => {
    const avatars = vi.fn().mockResolvedValue({ avatars: { "alice@developershub.jp": "https://img.example/alice.png" } });
    render(
      <MailApiProvider value={apiWith(avatars)}>
        <SenderAvatar p={{ email: "Alice@developershub.jp", name: "Alice" }} />
        <SenderAvatar p={{ email: "stranger@gmail.com", name: "Stranger" }} />
        <SenderAvatar p={{ email: "alice@developershub.jp" }} />
      </MailApiProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("fe2-mail-avatar-img")).toHaveLength(2));
    expect(avatars).toHaveBeenCalledTimes(1);
    expect(avatars.mock.calls[0]![0]).toEqual(["alice@developershub.jp", "stranger@gmail.com"]);
    const [, stranger] = screen.getAllByTestId("fe2-mail-avatar");
    expect(stranger!.textContent).toBe("S");
    expect(stranger!.querySelector("img")).toBeNull();
  });

  it("falls back to the initial when the image fails to load or the lookup fails", async () => {
    const ok = vi.fn().mockResolvedValue({ avatars: { "bob@developershub.jp": "https://img.example/broken.png" } });
    const { unmount } = render(
      <MailApiProvider value={apiWith(ok)}>
        <SenderAvatar p={{ email: "bob@developershub.jp", name: "Bob" }} />
      </MailApiProvider>,
    );
    const img = await screen.findByTestId("fe2-mail-avatar-img");
    fireEvent.error(img);
    expect(screen.queryByTestId("fe2-mail-avatar-img")).toBeNull();
    expect(screen.getByTestId("fe2-mail-avatar").textContent).toBe("B");
    unmount();

    const failing = vi.fn().mockRejectedValue(new Error("down"));
    render(
      <MailApiProvider value={apiWith(failing)}>
        <SenderAvatar p={{ email: "carol@developershub.jp", name: "Carol" }} />
      </MailApiProvider>,
    );
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.getByTestId("fe2-mail-avatar").textContent).toBe("C");
  });

  it("renders the initial without a MailApi provider", () => {
    render(<SenderAvatar p={{ email: "dave@example.com", name: "Dave" }} />);
    expect(screen.getByTestId("fe2-mail-avatar").textContent).toBe("D");
  });
});
