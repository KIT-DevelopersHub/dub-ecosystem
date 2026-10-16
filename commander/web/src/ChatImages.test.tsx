// Pasting images into the chat (Claude Code style): paste / drop / 📎 → thumbnail strip →
// send uploads each image to the daemon and starts the run with the upload ids.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AskDub } from "./AskDub.tsx";
import { ChatProvider, imageNote } from "./lib/chatStore.tsx";
import { makeFakeApi, makeFakeClient } from "./test/fakes.ts";
import { imageFiles } from "./lib/images.ts";
import { IMAGE_ONLY_TEXT } from "./ChatUI.tsx";

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

function setup() {
  const api = makeFakeApi();
  const client = makeFakeClient([
    { type: "claude", data: { type: "result", subtype: "success", result: "赤いボタンです。" } },
    { type: "status", status: "succeeded" },
  ]);
  render(
    <ChatProvider api={api} client={client}>
      <AskDub />
    </ChatProvider>,
  );
  return { api, client };
}

const paste = (files: File[], text = "") =>
  fireEvent.paste(screen.getByTestId("chat-input"), {
    clipboardData: { files, getData: () => text, types: files.length ? ["Files"] : ["text/plain"] },
  });

describe("chat image paste", () => {
  beforeEach(() => localStorage.clear());

  it("keeps only image files from a paste/drop payload", () => {
    const txt = new File(["a"], "a.txt", { type: "text/plain" });
    expect(imageFiles([png("a.png"), txt]).map((f) => f.name)).toEqual(["a.png"]);
    expect(imageFiles(null)).toEqual([]);
  });

  it("shows a thumbnail for a pasted image and removes it with ×", async () => {
    setup();
    paste([png("shot.png")]);
    const strip = await screen.findByTestId("chat-attachments");
    expect(within(strip).getByAltText("shot.png")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chat-attachment-remove"));
    await waitFor(() => expect(screen.queryByTestId("chat-attachments")).toBeNull());
  });

  it("uploads the images and starts the run with their ids; an image alone can be sent", async () => {
    const { api, client } = setup();
    paste([png("a.png"), png("b.png")]);
    await waitFor(() => expect(screen.getAllByTestId("chat-attachment")).toHaveLength(2));
    // No text typed: sending is still allowed.
    expect(screen.getByTestId("chat-send")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("chat-send"));

    await waitFor(() => expect(client.startRun).toHaveBeenCalled());
    expect(client.uploadImage).toHaveBeenCalledTimes(2);
    expect(client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "image/png", data: "iVBORw0KGgo=" }));
    const [prompt, opts] = client.startRun.mock.calls[0]!;
    expect(prompt).toContain(IMAGE_ONLY_TEXT);
    expect(opts.images).toEqual(["up-1", "up-2"]);

    // The bubble shows the thumbnails; D1 keeps only a note (never the bytes).
    const log = screen.getByTestId("chat-log");
    expect(await within(log).findAllByAltText(/添付画像/)).toHaveLength(2);
    expect(screen.queryByTestId("chat-attachments")).toBeNull();
    const stored = api._messages.find((m) => m.role === "user")!;
    expect(stored.text).toBe(`${IMAGE_ONLY_TEXT}\n${imageNote(2)}`);
    expect(stored.text).not.toContain("iVBOR");
  });

  it("leaves a plain-text paste to the browser", () => {
    setup();
    paste([], "hello");
    expect(screen.queryByTestId("chat-attachments")).toBeNull();
  });

  it("opens the full-size viewer from a sent thumbnail", async () => {
    setup();
    paste([png("a.png")]);
    await screen.findByTestId("chat-attachment");
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "これ何?" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    fireEvent.click(await screen.findByLabelText("添付画像 1 を拡大"));
    expect(screen.getByTestId("chat-image-viewer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-image-viewer"));
    expect(screen.queryByTestId("chat-image-viewer")).toBeNull();
  });
});
