import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AskDub } from "./AskDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient, type FakeApi } from "./test/fakes.ts";
import { ASK_RUN_ARGS, DUB_ECOSYSTEM_CWD } from "./lib/askDub.ts";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

const answerFlow: DaemonRunEvent[] = [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "calendar" } }] } } },
  { type: "claude", data: { type: "result", subtype: "success", result: "カレンダーは apps/fe9-calendar にあります。" } },
  { type: "status", status: "succeeded" },
];

function renderAsk(api: FakeApi, client: CommanderClient) {
  return render(
    <ChatProvider api={api} client={client}>
      <AskDub />
    </ChatProvider>,
  );
}

describe("<AskDub> (multi-session, persisted)", () => {
  beforeEach(() => localStorage.clear());

  it("auto-creates a session, streams the answer, and runs read-only in dub-ecosystem", async () => {
    const api = makeFakeApi();
    const client = makeFakeClient(answerFlow);
    renderAsk(api, client);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "カレンダーはどこ?" } });
    fireEvent.click(screen.getByTestId("chat-send"));

    // Assert within the message log (the question also appears as the session title).
    const log = await screen.findByTestId("chat-log");
    expect(await within(log).findByText("カレンダーはどこ?")).toBeInTheDocument();
    expect(await within(log).findByText(/apps\/fe9-calendar/)).toBeInTheDocument();

    expect(client.startRun).toHaveBeenCalledWith(
      expect.stringContaining("質問: カレンダーはどこ?"),
      { cwd: DUB_ECOSYSTEM_CWD, args: ASK_RUN_ARGS },
    );
    // History persisted to the service (survives restart): user + assistant rows.
    await waitFor(() => expect(api._messages.filter((m) => m.role === "user")).toHaveLength(1));
    expect(api._messages.some((m) => m.role === "assistant" && /fe9-calendar/.test(m.text))).toBe(true);
  });

  it("re-injects prior turns into a follow-up prompt", async () => {
    const api = makeFakeApi();
    const client = makeFakeClient(answerFlow);
    renderAsk(api, client);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "最初の質問" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await screen.findByText(/apps\/fe9-calendar/);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "その続きは?" } });
    fireEvent.click(screen.getByTestId("chat-send"));

    await waitFor(() => {
      const calls = (client.startRun as ReturnType<typeof makeFakeClient>["startRun"]).mock.calls;
      const followup = calls[calls.length - 1]?.[0] as string;
      expect(followup).toContain("これまでの会話");
      expect(followup).toContain("最初の質問");
      expect(followup).toContain("質問: その続きは?");
    });
  });

  it("creates multiple sessions and switches between them", async () => {
    const api = makeFakeApi();
    renderAsk(api, makeFakeClient(answerFlow));

    fireEvent.click(screen.getByTestId("chat-new-session"));
    await waitFor(() => expect(screen.getAllByTestId("chat-session")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("chat-new-session"));
    await waitFor(() => expect(screen.getAllByTestId("chat-session")).toHaveLength(2));

    // Exactly one active at a time.
    const active = screen.getAllByTestId("chat-session").filter((s) => s.getAttribute("data-active") === "1");
    expect(active).toHaveLength(1);
  });

  it("keeps the composer draft per session across unmount/remount (Task 3)", async () => {
    const api = makeFakeApi();
    const client = makeFakeClient(answerFlow);
    // Seed a session so the draft is keyed to a real session id.
    const session = await api.createChat("ask");

    const view = renderAsk(api, client);
    await waitFor(() => expect(screen.getByTestId("chat-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "書きかけの下書き" } });
    // Persisted under the active session's draft key.
    expect(localStorage.getItem(`commander.draft.${session.id}`)).toBe("書きかけの下書き");

    // Navigate away (unmount) and back (remount) — draft restores.
    view.unmount();
    renderAsk(api, client);
    await waitFor(() =>
      expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("書きかけの下書き"),
    );
  });
});
