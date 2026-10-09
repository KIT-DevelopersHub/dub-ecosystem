// Manual chat naming: the operator can rename a session from the sidebar, and the name
// they chose must survive the first question (which otherwise auto-titles the session).
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AskDub } from "./AskDub.tsx";
import { ChatProvider } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient, type FakeApi } from "./test/fakes.ts";
import type { CommanderClient, DaemonRunEvent } from "./lib/client.ts";

const answerFlow: DaemonRunEvent[] = [
  { type: "status", status: "running" },
  { type: "claude", data: { type: "result", subtype: "success", result: "答えです。" } },
  { type: "status", status: "succeeded" },
];

function renderAsk(api: FakeApi, client: CommanderClient = makeFakeClient(answerFlow)) {
  return render(
    <ChatProvider api={api} client={client}>
      <AskDub />
    </ChatProvider>,
  );
}

/** Open the inline editor on the first row and type `name` (without committing). */
async function startRename(name: string): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByTestId("chat-rename-session"));
  const input = (await screen.findByTestId("chat-rename-input")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: name } });
  return input;
}

describe("chat session rename", () => {
  beforeEach(() => localStorage.clear());

  it("renames the session in the sidebar and persists it via the API", async () => {
    const api = makeFakeApi();
    await api.createChat("ask");
    renderAsk(api);

    const input = await startRename("  カレンダー調査  ");
    fireEvent.keyDown(input, { key: "Enter" });

    // Trimmed name shown in the sidebar…
    await waitFor(() => expect(screen.getByTestId("chat-select-session")).toHaveTextContent("カレンダー調査"));
    // …and written through to the service.
    await waitFor(() => expect(api.renameChat).toHaveBeenCalledWith("chat-1", "カレンダー調査"));
    expect(api._sessions[0]?.title).toBe("カレンダー調査");
  });

  it("keeps an operator-chosen name when the first question is sent", async () => {
    const api = makeFakeApi();
    await api.createChat("ask");
    renderAsk(api);

    fireEvent.keyDown(await startRename("リリース準備"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("chat-select-session")).toHaveTextContent("リリース準備"));

    // The first user message would normally become the title — it must not win here.
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "カレンダーはどこ?" } });
    fireEvent.click(screen.getByTestId("chat-send"));

    await waitFor(() => expect(api._messages.filter((m) => m.role === "user")).toHaveLength(1));
    expect(screen.getByTestId("chat-select-session")).toHaveTextContent("リリース準備");
    expect(api._sessions[0]?.title).toBe("リリース準備");
  });

  it("still auto-titles a session that was never named", async () => {
    const api = makeFakeApi();
    renderAsk(api);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "カレンダーはどこ?" } });
    fireEvent.click(screen.getByTestId("chat-send"));

    await waitFor(() => expect(screen.getByTestId("chat-select-session")).toHaveTextContent("カレンダーはどこ?"));
  });

  it("rejects an empty name and keeps the current one", async () => {
    const api = makeFakeApi();
    await api.createChat("ask", "元の名前");
    renderAsk(api);

    const input = await startRename("   ");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("chat-rename-input")).not.toBeInTheDocument());
    expect(screen.getByTestId("chat-select-session")).toHaveTextContent("元の名前");
    expect(api.renameChat).not.toHaveBeenCalled();
  });

  it("cancels on Escape without writing", async () => {
    const api = makeFakeApi();
    await api.createChat("ask", "元の名前");
    renderAsk(api);

    const input = await startRename("捨てる名前");
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("chat-rename-input")).not.toBeInTheDocument());
    expect(screen.getByTestId("chat-select-session")).toHaveTextContent("元の名前");
    expect(api.renameChat).not.toHaveBeenCalled();
  });

  it("rolls back the optimistic name when the service rejects the write", async () => {
    const api = makeFakeApi();
    await api.createChat("ask", "元の名前");
    api.renameChat = async () => {
      throw new Error("service down");
    };
    renderAsk(api);

    fireEvent.keyDown(await startRename("新しい名前"), { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("chat-select-session")).toHaveTextContent("元の名前"));
  });
});
