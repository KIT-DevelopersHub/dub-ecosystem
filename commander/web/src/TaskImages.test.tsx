// Screenshots on the task side: the new-task prompt, 追加指示 and 却下 forms accept pasted
// images and start the run with the daemon upload ids (same path as the chat).
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "./Board.tsx";
import { imageNote } from "./lib/chatStore.tsx";
import { IMAGE_ONLY_TEXT } from "./ChatUI.tsx";
import { makeBoardItem, makeFakeApi, makeFakeClient } from "./test/fakes.ts";

// jsdom cannot decode images, so the canvas shrink step is stubbed.
vi.mock("./lib/images.ts", async (orig) => {
  const real = await orig<typeof import("./lib/images.ts")>();
  return {
    ...real,
    prepareImage: vi.fn(async (file: File) => ({
      id: `img-${file.name}`,
      name: file.name,
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
      previewUrl: `data:image/png;base64,${file.name}`,
    })),
  };
});

const png = (name: string) => new File(["x"], name, { type: "image/png" });
const paste = (el: HTMLElement, files: File[]) =>
  fireEvent.paste(el, { clipboardData: { files, getData: () => "", types: ["Files"] } });

function reviewBoard() {
  const api = makeFakeApi([
    makeBoardItem({ taskId: "rev", featureId: "feat-1", title: "画像対象", featurePhase: "demo_review", runStatus: "succeeded" }),
  ]);
  const client = makeFakeClient();
  render(<Board client={client} api={api} pollMs={0} />);
  return { api, client };
}

describe("task image paste", () => {
  it("new task: pasted image is uploaded and its id goes with the first run", async () => {
    const client = makeFakeClient();
    render(<Board client={client} api={makeFakeApi([])} pollMs={0} />);
    await screen.findByTestId("board-empty");

    await userEvent.click(screen.getByTestId("open-composer"));
    await userEvent.type(screen.getByLabelText("task-title"), "崩れを直す");
    await userEvent.type(screen.getByLabelText("task-prompt"), "この画面を直して");
    paste(screen.getByLabelText("task-prompt"), [png("broken.png")]);
    const strip = await screen.findByTestId("composer-attachments");
    expect(within(strip).getByAltText("broken.png")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "image/png" }));
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toBe(`この画面を直して\n${imageNote(1)}`);
    expect(opts.images).toEqual(["up-1"]);
  });

  it("追加指示: image-only send uses the default text and attaches the image", async () => {
    const { client } = reviewBoard();
    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-rerun"));
    expect(screen.getByTestId("rerun-submit")).toBeDisabled();

    paste(screen.getByLabelText("rerun-prompt"), [png("a.png"), png("b.png")]);
    await waitFor(() => expect(screen.getAllByTestId("rerun-attachment")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("rerun-submit")).toBeEnabled());
    await userEvent.click(screen.getByTestId("rerun-submit"));

    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toContain(IMAGE_ONLY_TEXT);
    expect(prompt).toContain(imageNote(2));
    expect(opts.images).toEqual(["up-1", "up-2"]);
    expect(opts.taskId).toBe("rev");
  });

  it("却下: feedback + image go into the fix run; × removes an image before sending", async () => {
    const { client } = reviewBoard();
    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-reject"));
    const box = screen.getByLabelText("reject-feedback");
    await userEvent.type(box, "ここがずれている");
    paste(box, [png("keep.png"), png("drop.png")]);
    await waitFor(() => expect(screen.getAllByTestId("reject-attachment")).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "drop.png を外す" }));
    expect(screen.getAllByTestId("reject-attachment")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("reject-submit"));
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).toContain("ここがずれている");
    expect(opts.images).toEqual(["up-1"]);
  });

  it("runs without images keep the old request shape", async () => {
    const { client } = reviewBoard();
    await userEvent.click(await screen.findByTestId("task-card-rev"));
    await userEvent.click(await screen.findByTestId("action-rerun"));
    await userEvent.type(screen.getByLabelText("rerun-prompt"), "文字だけ");
    await userEvent.click(screen.getByTestId("rerun-submit"));
    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    const [prompt, opts] = client.startRun.mock.calls.at(-1)!;
    expect(prompt).not.toContain("画像");
    expect(opts.images).toBeUndefined();
    expect(client.uploadImage).not.toHaveBeenCalled();
  });
});
