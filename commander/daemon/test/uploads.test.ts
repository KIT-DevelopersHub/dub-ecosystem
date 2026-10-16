// Pasted images: POST /uploads stages one image, POST /runs { images } consumes it and
// feeds claude a stream-json user message on stdin (image blocks + text).
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/server.ts";
import { UploadStore, MAX_IMAGE_BYTES } from "../src/uploads.ts";
import { imageMessageLine } from "../src/runner.ts";
import type { DaemonConfig } from "../src/types.ts";

const STDIN_CLAUDE = fileURLToPath(new URL("./fixtures/stdin-echo-claude", import.meta.url));
chmodSync(STDIN_CLAUDE, 0o755);
const PNG_B64 = "iVBORw0KGgo=";

function config(): DaemonConfig {
  return {
    port: 0,
    claudeBin: STDIN_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    idleTimeoutMs: 0,
    runTimeoutMs: 0,
    isolateEnv: false,
    claudeConfigDir: "",
    permissionMode: "",
  };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (close) await close();
  close = null;
});

async function listen() {
  const { server, store } = createDaemonServer(config());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { base: `http://127.0.0.1:${port}`, store };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("UploadStore", () => {
  it("accepts supported images and rejects bad type / data / size", () => {
    const s = new UploadStore();
    expect(s.stage("image/png", PNG_B64).ok).toBe(true);
    expect(s.stage("image/svg+xml", PNG_B64)).toEqual({ ok: false, error: "unsupported_media_type" });
    expect(s.stage("image/png", "not base64!")).toEqual({ ok: false, error: "invalid_image_data" });
    expect(s.stage("image/png", "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4))).toEqual({
      ok: false,
      error: "image_too_large",
    });
  });

  it("take() consumes once, and refuses unknown / duplicate / expired ids", () => {
    let now = 0;
    const s = new UploadStore(() => now);
    const a = s.stage("image/png", PNG_B64);
    if (!a.ok) throw new Error("stage failed");
    expect(s.take([a.id, a.id])).toBeNull();
    expect(s.take([a.id, "nope"])).toBeNull();
    expect(s.take([a.id])).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    expect(s.take([a.id])).toBeNull(); // already consumed

    const b = s.stage("image/png", PNG_B64);
    if (!b.ok) throw new Error("stage failed");
    now += 31 * 60_000;
    expect(s.take([b.id])).toBeNull(); // expired
  });
});

describe("imageMessageLine", () => {
  it("puts images before the prompt text in one user turn", () => {
    const line = imageMessageLine("この画面を見て", [{ mediaType: "image/png", data: PNG_B64 }]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          { type: "text", text: "この画面を見て" },
        ],
      },
    });
  });
});

describe("daemon HTTP — POST /uploads + POST /runs { images }", () => {
  it("sends the staged image to claude on stdin (stream-json input)", async () => {
    const { base, store } = await listen();
    const up = await post(`${base}/uploads`, { mediaType: "image/png", data: PNG_B64 });
    expect(up.status).toBe(201);
    const { uploadId } = (await up.json()) as { uploadId: string };

    const res = await post(`${base}/runs`, { prompt: "見て", images: [uploadId] });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };

    await expect.poll(() => store.get(runId)?.status, { timeout: 5000 }).toBe("succeeded");
    const run = store.get(runId)!;
    expect(run.imageCount).toBe(1);
    const resultEv = run.events.find((e) => e.type === "claude") as { data: { result: string } };
    const echoed = JSON.parse(resultEv.data.result) as { argv: string[]; stdin: string };
    expect(echoed.argv.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(echoed.argv).not.toContain("見て"); // prompt rides stdin, not argv
    const msg = JSON.parse(echoed.stdin) as { message: { content: { type: string }[] } };
    expect(msg.message.content.map((c) => c.type)).toEqual(["image", "text"]);

    // The image was consumed by that run.
    expect((await post(`${base}/runs`, { prompt: "再", images: [uploadId] })).status).toBe(400);
  });

  it("rejects bad uploads and malformed image lists", async () => {
    const { base } = await listen();
    expect((await post(`${base}/uploads`, { mediaType: "text/html", data: PNG_B64 })).status).toBe(400);
    expect((await post(`${base}/runs`, { prompt: "p", images: "x" })).status).toBe(400);
    expect((await post(`${base}/runs`, { prompt: "p", images: ["unknown"] })).status).toBe(400);
  });
});
