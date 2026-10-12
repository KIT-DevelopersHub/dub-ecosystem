// ドライブ共有・LP の書き込みエントリを、インメモリの fake api-gateway に対して
// preview -> execute -> 読み直しまで通す。`noop` を立てると fake は書き込みを 2xx で受けて
// 何も変えない（読み直しで unverified になることを確かめる）。
import { CATALOG, findEntry } from "../src/operate/catalog.ts";
import { OperateExecutor } from "../src/operate/executor.ts";
import { GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan } from "../src/operate/plan.ts";

interface Perm {
  id: string;
  type: string;
  role: string;
  emailAddress: string | null;
  inherited: boolean;
}

function fakeGateway(opts: { noop?: boolean } = {}) {
  const perms: Perm[] = [
    { id: "p-owner", type: "user", role: "owner", emailAddress: "hackit@example.jp", inherited: false },
    { id: "p-a", type: "user", role: "reader", emailAddress: "a@example.jp", inherited: false },
  ];
  const grants = [{ fileId: "f1", roleId: "role_x", roleName: "運営", driveRole: "reader", memberCount: 3, appliedCount: 2 }];
  const folders: Record<string, { id: string; name: string }[]> = { fold1: [{ id: "f1", name: "議事録" }], fold2: [] };
  const links = [{ id: "l1", name: "Instagram", slug: "insta", url: "https://lp.example/?utm_source=insta", active: true }];
  const calls: string[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(`${method} ${path}${url.search}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(data === null ? null : JSON.stringify(data), { status });
    const noop = opts.noop && method !== "GET";
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/driveshare\/files\/f1\/permissions(?:\/([^/]+))?$/))) {
      const permId = m[1];
      if (method === "GET") return reply(200, { fileId: "f1", permissions: perms });
      if (method === "POST") {
        const p = { id: `p-${body.emailAddress}`, type: "user", role: body.role, emailAddress: body.emailAddress, inherited: false };
        if (!noop) perms.push(p);
        return reply(201, { permission: p });
      }
      const p = perms.find((x) => x.id === permId);
      if (!p) return reply(404, { error: { code: "not_found" } });
      if (method === "PATCH") {
        if (!noop) p.role = body.role;
        return reply(200, { permission: { ...p, role: body.role } });
      }
      if (!noop) perms.splice(perms.indexOf(p), 1);
      return reply(200, { revoked: true });
    }
    if (path === "/driveshare/files/f1/link" && method === "PUT") {
      if (!noop) {
        const i = perms.findIndex((x) => x.type === "anyone");
        if (i >= 0) perms.splice(i, 1);
        if (body.enabled) perms.push({ id: "anyoneWithLink", type: "anyone", role: body.role ?? "reader", emailAddress: null, inherited: false });
      }
      return reply(200, { fileId: "f1", permissions: perms });
    }
    if ((m = path.match(/^\/driveshare\/files\/f1\/role-grants(?:\/([^/]+))?(\/reapply)?$/))) {
      const roleId = m[1];
      if (method === "GET") return reply(200, { items: grants });
      if (method === "POST" && m[2]) {
        const g = grants.find((x) => x.roleId === roleId);
        if (!g) return reply(404, { error: { code: "not_found" } });
        const after = { ...g, appliedCount: g.memberCount };
        if (!noop) Object.assign(g, after);
        return reply(200, after);
      }
      if (method === "POST") {
        const g = { fileId: "f1", roleId: body.roleId, roleName: "新ロール", driveRole: body.driveRole, memberCount: 2, appliedCount: 2 };
        if (!noop) grants.push(g);
        return reply(201, g);
      }
      const i = grants.findIndex((x) => x.roleId === roleId);
      if (!noop && i >= 0) grants.splice(i, 1);
      return reply(204, null);
    }
    if (path === "/drive/files" && method === "GET") return reply(200, { items: folders[url.searchParams.get("folderId") ?? ""] ?? [], nextCursor: null });
    if ((m = path.match(/^\/drive\/files\/([^/]+)\/move$/))) {
      const from = Object.values(folders).find((f) => f.some((x) => x.id === m![1]));
      const file = from?.find((x) => x.id === m![1]);
      if (!file) return reply(404, { error: { code: "not_found" } });
      if (!noop) {
        from!.splice(from!.indexOf(file), 1);
        folders[body.newParentId]!.push(file);
      }
      return reply(200, { file });
    }
    if (path.startsWith("/lp/links")) {
      if (!url.searchParams.get("from") || !url.searchParams.get("to")) return reply(400, { error: { code: "validation_failed" } });
      if (method === "GET") return reply(200, { items: links });
      if (method === "POST") {
        const l = { id: `l${links.length + 1}`, name: body.name, slug: body.slug, url: `https://lp.example/?utm_source=${body.slug}`, active: true };
        if (!noop) links.push(l);
        return reply(201, { ...l, stats: { visits: 0 } });
      }
      const l = links.find((x) => x.id === path.split("/")[3]);
      if (!l) return reply(404, { error: { code: "not_found" } });
      if (!noop) l.active = body.active;
      return reply(200, { ...l, active: body.active });
    }
    return reply(404, { error: { code: "no_route" } });
  }) as typeof fetch;

  const exec = new OperateExecutor(
    new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", token: "t" }, fetchImpl),
    { append() {} },
  );
  return { exec, calls, perms, grants, folders, links };
}

async function run(exec: OperateExecutor, step: Record<string, unknown>) {
  const p = parsePlan({ summary: "", steps: [{ id: "w", ...step }] });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  expect(preview.blockers).toEqual([]);
  return { preview, result: await exec.execute(preview.previewId) };
}

const RANGE = { from: "2026-10-01", to: "2026-10-12" };

// [entry id, plan step] — one happy path per write; `noop` must turn each into unverified.
const CASES: [string, Record<string, unknown>][] = [
  ["driveshare.permissions.grant", { params: { id: "f1" }, body: { emailAddress: "b@example.jp", role: "writer" } }],
  ["driveshare.permissions.update", { params: { id: "f1", permId: "p-a" }, body: { role: "commenter" } }],
  ["driveshare.permissions.revoke", { params: { id: "f1", permId: "p-a" } }],
  ["driveshare.roleGrants.apply", { params: { id: "f1" }, body: { roleId: "role_y", driveRole: "commenter" } }],
  ["driveshare.roleGrants.revoke", { params: { id: "f1", roleId: "role_x" } }],
  ["driveshare.roleGrants.reapply", { params: { id: "f1", roleId: "role_x" } }],
  ["driveshare.link.set", { params: { id: "f1" }, body: { enabled: true, role: "reader" } }],
  ["drive.files.move", { params: { id: "f1" }, body: { newParentId: "fold2" } }],
  ["lp.links.create", { query: RANGE, body: { name: "X 告知", slug: "x-post" } }],
  ["lp.links.setActive", { params: { id: "l1" }, query: RANGE, body: { active: false } }],
];

describe("drive / lp writes", () => {
  it("opens every pending drive and lp route", () => {
    const ids = CATALOG.filter((e) => (e.area === "drive" || e.area === "lp") && e.kind !== "read").map((e) => e.id).sort();
    expect(ids).toEqual(CASES.map(([id]) => id).sort());
    for (const id of ids) {
      const v = findEntry(id)!.verify;
      if (v?.present !== undefined) expect(v.findIn, id).toBeDefined();
    }
  });

  it.each(CASES)("%s is applied and confirmed by reading it back", async (op, step) => {
    const { exec } = fakeGateway();
    const { preview, result } = await run(exec, { op, ...step });
    expect(preview.requiresPhrase).toBe(findEntry(op)!.risk === "high");
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
  });

  it.each(CASES)("%s accepted but not applied is reported as unverified", async (op, step) => {
    const { exec } = fakeGateway({ noop: true });
    const { result } = await run(exec, { op, ...step });
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("checks that link sharing is gone after turning it off", async () => {
    const g = fakeGateway();
    await run(g.exec, { op: "driveshare.link.set", params: { id: "f1" }, body: { enabled: true, role: "reader" } });
    const off = await run(g.exec, { op: "driveshare.link.set", params: { id: "f1" }, body: { enabled: false } });
    expect(off.result).toMatchObject({ verdict: "done" });
    expect(g.perms.some((p) => p.type === "anyone")).toBe(false);

    // Off accepted but the link permission is still there.
    const stuck = fakeGateway({ noop: true });
    stuck.perms.push({ id: "anyoneWithLink", type: "anyone", role: "reader", emailAddress: null, inherited: false });
    const res = await run(stuck.exec, { op: "driveshare.link.set", params: { id: "f1" }, body: { enabled: false } });
    expect(res.result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect(JSON.stringify(res.result)).toContain("まだ残っています");
  });

  it("re-reads an lp link with the same date range the write was given", async () => {
    const g = fakeGateway();
    await run(g.exec, { op: "lp.links.setActive", params: { id: "l1" }, query: RANGE, body: { active: false } });
    expect(g.calls.filter((c) => c.startsWith("GET /lp/links"))).toEqual(["GET /lp/links?from=2026-10-01&to=2026-10-12"]);
  });

  it("re-reads a move in the destination folder", async () => {
    const g = fakeGateway();
    await run(g.exec, { op: "drive.files.move", params: { id: "f1" }, body: { newParentId: "fold2" } });
    expect(g.calls).toContain("GET /drive/files?folderId=fold2&limit=100");
    expect(g.folders.fold2!.map((f) => f.id)).toEqual(["f1"]);
  });
});
