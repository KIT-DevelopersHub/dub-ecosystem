// 定型文 (#867): pick a template to fill the compose, save / delete optimistically with rollback.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { TemplatePicker, applyTemplate } from "./TemplatePicker.tsx";

const T1: mail.MailTemplate = { id: "tpl-1", title: "面談のご案内", subject: "面談日程について", body: "候補日をお送りします。", updatedAt: "2026-11-01T00:00:00.000Z" };

function api(over: Partial<MailApi> = {}): MailApi {
  return {
    listTemplates: vi.fn().mockResolvedValue([T1]),
    saveTemplate: vi.fn().mockImplementation((id: string, t: mail.MailTemplateInput) => Promise.resolve({ ...t, id, updatedAt: "2026-11-02T00:00:00.000Z" })),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as MailApi;
}

function Harness({ initial = { subject: "", body: "" } }: { initial?: { subject: string; body: string } }): JSX.Element {
  const [c, setC] = useState(initial);
  return (
    <>
      <TemplatePicker compose={c} onInsert={setC} />
      <output data-testid="subject">{c.subject}</output>
      <output data-testid="body">{c.body}</output>
    </>
  );
}

const renderWith = (a: MailApi, initial?: { subject: string; body: string }) =>
  render(
    <MailApiProvider value={a}>
      <Harness {...(initial ? { initial } : {})} />
    </MailApiProvider>,
  );

describe("applyTemplate", () => {
  it("replaces the subject only when the template has one and puts its body above typed text", () => {
    expect(applyTemplate({ subject: "", body: "" }, T1)).toEqual({ subject: "面談日程について", body: "候補日をお送りします。" });
    expect(applyTemplate({ subject: "Re: x", body: "> quote" }, { ...T1, subject: "" })).toEqual({ subject: "Re: x", body: "候補日をお送りします。\n\n> quote" });
  });
});

describe("TemplatePicker", () => {
  it("lists templates (skeleton first) and inserts the picked one", async () => {
    let resolve: (v: mail.MailTemplate[]) => void = () => {};
    renderWith(api({ listTemplates: vi.fn().mockReturnValue(new Promise<mail.MailTemplate[]>((r) => (resolve = r))) }));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-templates"));
    expect(screen.getByTestId("fe2-mail-templates-skeleton")).toBeInTheDocument();
    resolve([T1]);
    await userEvent.click(await screen.findByTestId("fe2-mail-template-insert-tpl-1"));
    expect(screen.getByTestId("subject")).toHaveTextContent("面談日程について");
    expect(screen.getByTestId("body")).toHaveTextContent("候補日をお送りします。");
    expect(screen.queryByTestId("fe2-mail-templates-dialog")).not.toBeInTheDocument();
  });

  it("saves the current compose as a template optimistically", async () => {
    const a = api({ listTemplates: vi.fn().mockResolvedValue([]) });
    renderWith(a, { subject: "お礼", body: "ありがとうございました。" });
    await userEvent.click(screen.getByTestId("fe2-mail-compose-templates"));
    expect(await screen.findByTestId("fe2-mail-templates-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-mail-template-save-current"));
    expect((screen.getByTestId("fe2-mail-template-title") as HTMLInputElement).value).toBe("お礼");
    await userEvent.click(screen.getByTestId("fe2-mail-template-save"));
    const list = await screen.findByTestId("fe2-mail-templates-list");
    expect(within(list).getAllByTestId("fe2-mail-template-row")).toHaveLength(1);
    expect(within(list).getAllByText("お礼").length).toBeGreaterThan(0);
    expect(a.saveTemplate).toHaveBeenCalledWith(expect.stringMatching(/^tpl-/), { title: "お礼", subject: "お礼", body: "ありがとうございました。" });
  });

  it("requires a name before saving", async () => {
    renderWith(api());
    await userEvent.click(screen.getByTestId("fe2-mail-compose-templates"));
    await userEvent.click(await screen.findByTestId("fe2-mail-template-new"));
    expect(screen.getByTestId("fe2-mail-template-save")).toBeDisabled();
  });

  it("rolls a failed delete back and says so", async () => {
    renderWith(api({ deleteTemplate: vi.fn().mockRejectedValue(new Error("down")) }));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-templates"));
    await userEvent.click(await screen.findByTestId("fe2-mail-template-delete-tpl-1"));
    await userEvent.click(within(screen.getByTestId("fe2-mail-template-delete-confirm")).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-templates-error")).toHaveTextContent("削除できませんでした"));
    expect(screen.getByTestId("fe2-mail-template-insert-tpl-1")).toBeInTheDocument();
  });
});
