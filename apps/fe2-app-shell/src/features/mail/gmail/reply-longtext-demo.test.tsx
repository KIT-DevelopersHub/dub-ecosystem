// Regression (end-to-end through the demo gateway, the same transport the VITE_DEMO preview
// uses): after an inline reply, the post-send re-sync (HYDRATE → APPLY_FLAGS) used to cancel
// the in-flight thread fill while it was still marked "loaded", so the reply stayed as the
// list snippet (newlines collapsed, cut at 140 chars). It must end up with the full body.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../../lib/api-client.tsx";
import { createDemoFetch } from "../../../lib/demo-seed.tsx";
import { createMailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";

const TEXT = [
  "全力エージェンシー",
  "高橋 優衣 様",
  "",
  "お世話になっております。",
  "一般社団法人Developers Hub「北陸ITカンファレンス」運営の高岡と申します。",
  "",
  "この度は、番組でのご紹介についてご提案いただき、誠にありがとうございます。",
  "ぜひ一度、番組概要・費用感・スケジュールについてお話を伺えればと思います。",
  "",
  "・11 月   5 日 ( 木 ) 14 : 30 ~ 15 : 00",
  "・11 月 10 日 ( 火 )   9 : 30 ~ 10 : 00",
  "",
  "よろしくお願いいたします。",
  "",
  "一般社団法人Developers Hub",
  "北陸ITカンファレンス 運営",
  "高岡己太朗",
].join("\n");

describe("inline reply through the demo gateway", () => {
  beforeEach(() => localStorage.clear());

  it("shows the sent long reply in full (all lines, last line included) after the re-sync", async () => {
    const demo = createDemoFetch();
    let flagsCalls = 0;
    // Real networks are slow: give the per-message detail fetch (GET /mail/sent/:id) some
    // latency so the re-sync's APPLY_FLAGS lands while the thread fill is still in flight —
    // the ordering the browser preview hit.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/mail/flags")) {
        flagsCalls++;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (/\/mail\/sent\/[^/?]+/.test(url)) await new Promise((r) => setTimeout(r, 120));
      return demo(input, init);
    };
    const api = createApiClient({ baseUrl: "https://demo.local", fetchImpl });
    render(
      <MailApiProvider value={createMailApi(api)}>
        <GmailApp />
      </MailApiProvider>,
    );
    const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
    const row = rows.find((r) => within(r).queryByText(/運営スタッフ/))!;
    await userEvent.click(row);
    const box = await screen.findByTestId("fe2-mail-inline-reply");
    fireEvent.change(box, { target: { value: TEXT } });
    const before = flagsCalls;
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    // The optimistic row already has the full text; wait for the post-send re-sync
    // (HYDRATE then APPLY_FLAGS) so we assert on the server-backed row.
    await waitFor(() => expect(flagsCalls).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 200));
    await waitFor(
      () => {
        const last = screen.getAllByTestId("fe2-mail-body-text").at(-1)!;
        expect(last.textContent).toBe(TEXT);
      },
      { timeout: 4000 },
    );
    // Stays full after the sync settles (no late overwrite back to the snippet).
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getAllByTestId("fe2-mail-body-text").at(-1)!.textContent).toBe(TEXT);
  });
});
