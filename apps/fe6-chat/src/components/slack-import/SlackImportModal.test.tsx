import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@dub/ui";
import type { common } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../../context";
import { ChatApiError } from "../../api/client";
import { MockChatClient } from "../../api/mock-client";
import { MockRealtimeClient } from "../../realtime/mock-client";
import { demoSeed, ME } from "../../dev/seed";
import { ChannelList } from "../ChannelList";
import { SlackImportModal } from "./SlackImportModal";

function setup(api = new MockChatClient(demoSeed())) {
  const runtime: ChatRuntime = {
    api,
    can: () => true,
    currentUserId: ME as common.UserId,
    createRealtimeClient: () => new MockRealtimeClient(),
  };
  const onImported = vi.fn();
  const onOpenChannel = vi.fn();
  render(
    <ChatRuntimeProvider value={runtime}>
      <ToastProvider>
        <SlackImportModal open onClose={vi.fn()} onImported={onImported} onOpenChannel={onOpenChannel} />
      </ToastProvider>
    </ChatRuntimeProvider>,
  );
  return { api, onImported, onOpenChannel };
}

describe("SlackImportModal", () => {
  it("shows skeletons, then the picker with 公開/非公開 and the already-imported badge", async () => {
    setup();
    expect(screen.getByTestId("fe6-slack-import-channels-loading")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("fe6-slack-import-channel");
    const design = rows.find((r) => r.dataset.channelName === "design-review")!;
    expect(within(design).getByText("取り込み済み")).toBeInTheDocument();
    const core = rows.find((r) => r.dataset.channelName === "conference-core")!;
    expect(within(core).getByText("非公開")).toBeInTheDocument();
    expect(screen.getByText(/直近 90 日分/)).toBeInTheDocument();
    expect(screen.getByText(/LMB を招待すると一覧に表示/)).toBeInTheDocument();
  });

  it("filters by name", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("fe6-slack-import-channel");
    await user.type(screen.getByTestId("fe6-slack-import-search"), "conf");
    const rows = screen.getAllByTestId("fe6-slack-import-channel");
    expect(rows.map((r) => r.dataset.channelName)).toEqual(["conference-core"]);
  });

  it("shows the failed job's reason with 再開", async () => {
    setup();
    const failed = await waitFor(() => {
      const card = screen.getAllByTestId("fe6-slack-import-job").find((c) => c.dataset.jobStatus === "failed");
      expect(card).toBeTruthy();
      return card!;
    });
    expect(within(failed).getByTestId("fe6-slack-import-job-error")).toHaveTextContent("LMB がこのチャンネルに参加していません");
    expect(within(failed).getByTestId("fe6-slack-import-resume")).toBeInTheDocument();
  });

  it("imports a picked channel to 完了 and offers to open it", async () => {
    const user = userEvent.setup();
    const { onImported, onOpenChannel } = setup();
    await user.click((await screen.findAllByTestId("fe6-slack-import-channel")).find((r) => r.dataset.channelName === "general")!);
    await user.click(screen.getByTestId("fe6-slack-import-start"));
    const card = () => screen.getAllByTestId("fe6-slack-import-job").find((c) => c.textContent?.includes("general") && !c.textContent.includes("design"))!;
    await waitFor(() => expect(card().dataset.jobStatus).toBe("done"), { timeout: 15_000 });
    expect(within(card()).getByTestId("fe6-slack-import-count-messages")).toHaveTextContent("5");
    expect(within(card()).getByTestId("fe6-slack-import-count-threadReplies")).toHaveTextContent("3");
    expect(onImported).toHaveBeenCalledTimes(1);
    await user.click(within(card()).getByTestId("fe6-slack-import-open-channel"));
    expect(onOpenChannel).toHaveBeenCalledWith("chn_slk_c01general");
  }, 20_000);

  it("rolls the optimistic row back when the server refuses", async () => {
    const user = userEvent.setup();
    const api = new MockChatClient(demoSeed());
    setup(api);
    await screen.findAllByTestId("fe6-slack-import-channel");
    const before = (await screen.findAllByTestId("fe6-slack-import-job")).length;
    api.nextError = new ChatApiError(429, { error: { code: "RATE_LIMITED", message: "slow down", retryable: true } });
    await user.type(screen.getByTestId("fe6-slack-import-manual"), "#random");
    await user.click(screen.getByTestId("fe6-slack-import-start"));
    await waitFor(() => expect(screen.getAllByTestId("fe6-slack-import-job")).toHaveLength(before));
    expect(await screen.findByText(/レート制限中/)).toBeInTheDocument();
  });

  it("shows the not-configured state on 412", async () => {
    const api = new MockChatClient(demoSeed());
    const err = new ChatApiError(412, { error: { code: "PRECONDITION_FAILED", message: "x", retryable: false } });
    api.listSlackChannels = () => Promise.reject(err);
    api.listSlackImportJobs = () => Promise.reject(err);
    setup(api);
    expect(await screen.findByTestId("fe6-slack-import-not-configured")).toHaveTextContent("SLACK_BOT_TOKEN");
  });
});

describe("ChannelList import entry", () => {
  const base = { channels: [], unread: {}, activeChannelId: null, canCreate: true, onSelect: vi.fn() };
  it("renders only when onImport is passed", async () => {
    const onImport = vi.fn();
    const { rerender } = render(<ChannelList {...base} />);
    expect(screen.queryByTestId("fe6-slack-import-open")).toBeNull();
    rerender(<ChannelList {...base} onImport={onImport} />);
    await userEvent.click(screen.getByTestId("fe6-slack-import-open"));
    expect(onImport).toHaveBeenCalled();
  });
});
