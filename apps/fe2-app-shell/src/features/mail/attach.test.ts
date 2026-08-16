import { describe, it, expect } from "vitest";
import {
  BLOCKED_EXTENSIONS,
  fileExtension,
  fileToAttachmentWithProgress,
  isBlockedFilename,
  isImageType,
  readFileWithProgress,
  validateIncomingFiles,
} from "./attach.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES } from "./mailApi.tsx";

// jsdom's File lacks a usable arrayBuffer()/slice pipe; a File-like carrying the fields used.
const fileLike = (name: string, size: number, type = "application/octet-stream"): File =>
  ({
    name,
    type,
    size,
    arrayBuffer: async () => new Uint8Array(Math.min(size, 8)).buffer,
  }) as unknown as File;

describe("attach: extension + type helpers", () => {
  it("fileExtension returns the final lower-case extension", () => {
    expect(fileExtension("report.PDF")).toBe("pdf");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension(".dotfile")).toBe(""); // leading dot only → no extension
  });

  it("isBlockedFilename blocks Gmail's executable/script types (case-insensitive)", () => {
    for (const ext of ["exe", "EXE", "js", "bat", "msi", "vbs", "jar", "scr", "ps1", "dll"]) {
      expect(isBlockedFilename(`payload.${ext}`)).toBe(true);
    }
  });

  it("isBlockedFilename allows normal document/media types", () => {
    for (const name of ["report.pdf", "photo.png", "sheet.xlsx", "notes.txt", "clip.mp4", "app.zip"]) {
      expect(isBlockedFilename(name)).toBe(false);
    }
  });

  it("the blocklist covers the core Gmail-blocked set", () => {
    for (const ext of ["exe", "bat", "cmd", "com", "js", "jar", "msi", "vbs", "scr", "ps1"]) {
      expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("isImageType detects image MIME types", () => {
    expect(isImageType("image/png")).toBe(true);
    expect(isImageType("image/jpeg")).toBe(true);
    expect(isImageType("application/pdf")).toBe(false);
  });
});

describe("attach: validateIncomingFiles", () => {
  it("accepts ordinary files", () => {
    const { accepted, rejected } = validateIncomingFiles([], [fileLike("a.pdf", 1000), fileLike("b.png", 2000, "image/png")]);
    expect(accepted.map((f) => f.name)).toEqual(["a.pdf", "b.png"]);
    expect(rejected).toHaveLength(0);
  });

  it("rejects blocked executable types with a reason", () => {
    const { accepted, rejected } = validateIncomingFiles([], [fileLike("virus.exe", 10)]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/セキュリティ/);
  });

  it("rejects empty files", () => {
    const { rejected } = validateIncomingFiles([], [fileLike("empty.txt", 0, "text/plain")]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/空/);
  });

  it("rejects a file over the per-file ceiling", () => {
    const { accepted, rejected } = validateIncomingFiles([], [fileLike("huge.bin", MAX_ATTACHMENT_BYTES + 1)]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/大きすぎ/);
  });

  it("enforces the max count against already-attached files", () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS }, () => ({ sizeBytes: 10 }));
    const { accepted, rejected } = validateIncomingFiles(existing, [fileLike("one-more.txt", 10, "text/plain")]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(new RegExp(`最大 ${MAX_ATTACHMENTS} 件`));
  });

  it("enforces the per-message total ceiling across existing + incoming", () => {
    const existing = [{ sizeBytes: MAX_ATTACHMENTS_TOTAL_BYTES - 1000 }];
    const { accepted, rejected } = validateIncomingFiles(existing, [fileLike("big.bin", 2000)]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/合計/);
  });
});

describe("attach: reading files", () => {
  it("readFileWithProgress falls back to arrayBuffer() and reports completion", async () => {
    let last = 0;
    const buf = await readFileWithProgress(fileLike("x.bin", 8), (p) => {
      last = p;
    });
    expect(buf.byteLength).toBe(8);
    expect(last).toBe(1);
  });

  it("fileToAttachmentWithProgress produces a base64 MailAttachmentInput", async () => {
    const att = await fileToAttachmentWithProgress(fileLike("x.png", 8, "image/png"));
    expect(att.filename).toBe("x.png");
    expect(att.contentType).toBe("image/png");
    expect(typeof att.contentBase64).toBe("string");
    expect(att.contentBase64.length).toBeGreaterThan(0);
  });
});
