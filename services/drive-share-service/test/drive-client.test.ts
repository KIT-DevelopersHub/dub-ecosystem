// Unit tests for the Drive-access seam: the domain mapping of Google permission
// resources (esp. the `inherited` derivation that gates the manager's revoke/role
// controls), the 403 reason → Japanese translation, and the REAL client's request
// shape (permissionDetails field mask + supportsAllDrives on every call). These pin
// the fix for the "cannotDeletePermission" bug: inherited grants are surfaced so the
// UI can disable revoke, and any 403 that still reaches the user is legible.
import { describe, expect, it, vi } from "vitest";
import { DubError } from "@dub/errors";
import { mapGoogleError, mapPermission } from "../src/drive-client";
import { createGoogleDriveShareClient } from "../src/google/client";
import type { TokenProvider } from "../src/google/token";

const staticToken: TokenProvider = { async getAccessToken(): Promise<string> { return "tok_test"; } };

describe("mapPermission — inherited derivation", () => {
  it("is inherited when every permissionDetails source is inherited", () => {
    const p = mapPermission({
      id: "p1", type: "user", role: "writer", emailAddress: "a@example.com",
      permissionDetails: [{ inherited: true }],
    });
    expect(p.inherited).toBe(true);
  });

  it("is NOT inherited when any source is direct (e.g. owner row: inherited writer + direct owner)", () => {
    const p = mapPermission({
      id: "p2", type: "user", role: "owner", emailAddress: "owner@example.com",
      permissionDetails: [{ inherited: true }, { inherited: false }],
    });
    expect(p.inherited).toBe(false);
  });

  it("is NOT inherited when permissionDetails is absent (direct grant on this item)", () => {
    const p = mapPermission({ id: "p3", type: "user", role: "reader", emailAddress: "b@example.com" });
    expect(p.inherited).toBe(false);
  });

  it("is NOT inherited for an empty permissionDetails array", () => {
    const p = mapPermission({ id: "p4", type: "anyone", role: "reader", permissionDetails: [] });
    expect(p.inherited).toBe(false);
  });
});

describe("mapGoogleError — 403 reason translation", () => {
  const body = (reason: string) => ({ error: { errors: [{ reason }], message: `raw ${reason}` } });

  it("translates cannotDeletePermission into a clear Japanese inherited message", () => {
    const err = mapGoogleError(403, body("cannotDeletePermission")) as DubError;
    expect(err).toBeInstanceOf(DubError);
    expect(err.message).toContain("親フォルダから継承");
    expect(err.message).toContain("剥奪できません");
    // never leaks the raw Google reason string to the user
    expect(err.message).not.toContain("cannotDeletePermission");
  });

  it("translates insufficientFilePermissions into a Japanese message", () => {
    const err = mapGoogleError(403, body("insufficientFilePermissions")) as DubError;
    expect(err.message).toContain("権限がありません");
  });

  it("falls back to a generic Japanese message (with reason tag) for unknown reasons", () => {
    const err = mapGoogleError(403, body("someNewReason")) as DubError;
    expect(err.message).toContain("Drive で操作が拒否されました");
    expect(err.message).toContain("someNewReason");
  });
});

describe("real Google client — request shape", () => {
  function fetchStub(res: Response): { impl: typeof fetch; urls: string[]; inits: RequestInit[] } {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      inits.push(init ?? {});
      return res.clone();
    }) as unknown as typeof fetch;
    return { impl, urls, inits };
  }

  it("listPermissions requests permissionDetails(inherited) + supportsAllDrives", async () => {
    const { impl, urls } = fetchStub(new Response(JSON.stringify({ permissions: [] }), { status: 200 }));
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await client.listPermissions("file_1");
    const url = decodeURIComponent(urls[0]!);
    expect(url).toContain("permissionDetails(inherited)");
    expect(url).toContain("supportsAllDrives=true");
  });

  it("deletePermission passes supportsAllDrives and tolerates a 404 (idempotent)", async () => {
    const { impl, urls, inits } = fetchStub(new Response(null, { status: 404 }));
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await expect(client.deletePermission("file_1", "perm_1")).resolves.toBeUndefined();
    expect(urls[0]).toContain("supportsAllDrives=true");
    expect(inits[0]!.method).toBe("DELETE");
  });

  it("deletePermission surfaces the Japanese message on a 403 cannotDeletePermission", async () => {
    const body = JSON.stringify({ error: { errors: [{ reason: "cannotDeletePermission" }] } });
    const { impl } = fetchStub(new Response(body, { status: 403 }));
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await expect(client.deletePermission("file_1", "perm_1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await client.deletePermission("file_1", "perm_2").catch((e: DubError) => {
      expect(e.message).toContain("親フォルダから継承");
    });
  });

  it("listFiles includes shared-drive params", async () => {
    const { impl, urls } = fetchStub(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await client.listFiles({ pageSize: 10 });
    const url = urls[0]!;
    expect(url).toContain("supportsAllDrives=true");
    expect(url).toContain("includeItemsFromAllDrives=true");
    expect(url).toContain("corpora=allDrives");
  });
});

describe("mapGoogleError — 400 reason translation", () => {
  const body = (reason: string) => ({ error: { errors: [{ reason }], message: `raw ${reason}` } });

  it("translates invalidSharingRequest (no Google account) into Japanese", () => {
    const err = mapGoogleError(400, body("invalidSharingRequest")) as DubError;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("Googleアカウント");
    expect(err.message).not.toContain("invalidSharingRequest");
  });

  it("translates invalid (malformed email) into Japanese", () => {
    const err = mapGoogleError(400, body("invalid")) as DubError;
    expect(err.message).toContain("メールアドレスの形式");
  });
});

describe("real client createPermission — notification fallback", () => {
  function scriptedFetch(responses: Response[]): { impl: typeof fetch; notify: (string | null)[] } {
    const notify: (string | null)[] = [];
    let i = 0;
    const impl = (async (input: string | URL | Request) => {
      notify.push(new URL(String(input)).searchParams.get("sendNotificationEmail"));
      return responses[i++]!.clone();
    }) as unknown as typeof fetch;
    return { impl, notify };
  }

  it("retries WITH a notification when Drive says invalidSharingRequest (no Google account)", async () => {
    const { impl, notify } = scriptedFetch([
      new Response(JSON.stringify({ error: { errors: [{ reason: "invalidSharingRequest" }] } }), { status: 400 }),
      new Response(JSON.stringify({ id: "p1", type: "user", role: "writer", emailAddress: "x@school.ac.jp" }), { status: 200 }),
    ]);
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    const perm = await client.createPermission("f1", { type: "user", role: "writer", emailAddress: "x@school.ac.jp" });
    expect(perm.emailAddress).toBe("x@school.ac.jp");
    // first silent, then retried with a notification
    expect(notify).toEqual(["false", "true"]);
  });

  it("does NOT retry when the first attempt succeeds (Google-account grantee, no email)", async () => {
    const { impl, notify } = scriptedFetch([
      new Response(JSON.stringify({ id: "p1", type: "user", role: "writer", emailAddress: "x@gmail.com" }), { status: 200 }),
    ]);
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await client.createPermission("f1", { type: "user", role: "writer", emailAddress: "x@gmail.com" });
    expect(notify).toEqual(["false"]); // exactly one call, no email-blast
  });

  it("does NOT retry for a malformed-email 400 (reason=invalid) and surfaces it", async () => {
    const { impl, notify } = scriptedFetch([
      new Response(JSON.stringify({ error: { errors: [{ reason: "invalid" }] } }), { status: 400 }),
    ]);
    const client = createGoogleDriveShareClient({ token: staticToken, fetchImpl: impl });
    await expect(client.createPermission("f1", { type: "user", role: "writer", emailAddress: "bogus" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(notify).toEqual(["false"]); // no retry for a non-sharing 400
  });
});
