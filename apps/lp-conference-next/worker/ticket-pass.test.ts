// Run: node --test worker/ticket-pass.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { inflateSync } from "node:zlib";
import { handlePass, matchPassRoute, matrixToPng, qrMatrix, renderPassPage, type PassDeps, type TicketPass } from "./ticket-pass.ts";

const TOKEN = "tko_01ABCDEFGHJKMNPQRSTVWXYZ01-1.abcdefghijklmnopqrstuvwx";
const PASS: TicketPass = { event: "北陸ITカンファレンス 2027", ticketTypeName: "一般", dayLabel: "Day 1", status: "valid", orderRef: "ABCD1234" };

function deps(answer: () => Response | Promise<Response>): PassDeps & { paths: string[] } {
  const paths: string[] = [];
  return {
    demo: false,
    paths,
    internal: async (path) => {
      paths.push(path);
      return answer();
    },
  };
}
const go = (path: string, d: PassDeps, method = "GET") => {
  const url = new URL(path, "https://lp.example");
  return handlePass(new Request(url, { method }), matchPassRoute(url.pathname)!, d);
};
const ok = () => deps(() => Response.json(PASS));
const missing = () => deps(() => new Response("{}", { status: 404 }));

function assertPrivate(res: Response): void {
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
}

test("matchPassRoute: owns /t, leaves everything else alone", () => {
  assert.deepEqual(matchPassRoute(`/t/${TOKEN}`), { kind: "page", token: TOKEN });
  assert.deepEqual(matchPassRoute(`/t/${TOKEN}/`), { kind: "page", token: TOKEN });
  assert.deepEqual(matchPassRoute(`/t/${TOKEN}/qr.png`), { kind: "qr", token: TOKEN });
  for (const p of ["/t", "/t/", "/t/x", "/t/a.b", `/t/${TOKEN}/extra`, "/t/..%2F"]) {
    assert.deepEqual(matchPassRoute(p), { kind: "page", token: null }, p);
  }
  for (const p of ["/", "/tickets", "/tickets/thanks", "/talks", "/top"]) assert.equal(matchPassRoute(p), null, p);
});

test("page: shows the ticket with its QR and private headers", async () => {
  const d = ok();
  const res = await go(`/t/${TOKEN}`, d);
  assert.equal(res.status, 200);
  assertPrivate(res);
  assert.deepEqual(d.paths, [`/lp/internal/tickets/pass/${encodeURIComponent(TOKEN)}`]);
  const html = await res.text();
  assert.ok(html.includes(`/t/${TOKEN}/qr.png`));
  assert.ok(html.includes("一般（Day 1）"));
  assert.ok(html.includes("ABCD1234"));
  assert.ok(html.includes('content="noindex"'));
  assert.ok(!html.includes("アプリで開く"));
});

test("invalid token and malformed path: the same 404, private headers, no QR", async () => {
  const unknown = await go(`/t/${TOKEN}`, missing());
  const malformed = await go("/t/nope", ok());
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assertPrivate(unknown);
  const a = await unknown.text();
  assert.equal(a, await malformed.text());
  assert.ok(!a.includes("qr.png"));
  assert.equal((await go(`/t/${TOKEN}/qr.png`, missing())).status, 404);
});

test("a malformed path never reaches lp-tickets", async () => {
  const d = ok();
  await go("/t/nope", d);
  assert.deepEqual(d.paths, []);
});

test("void: says so, and has no QR", async () => {
  const d = deps(() => Response.json({ ...PASS, status: "void" }));
  const res = await go(`/t/${TOKEN}`, d);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("無効"));
  assert.ok(!html.includes("qr.png"));
  assert.equal((await go(`/t/${TOKEN}/qr.png`, d)).status, 404);
});

test("lp-tickets down is not reported as an invalid ticket", async () => {
  const boom = deps(() => Promise.reject(new Error("x")));
  assert.equal((await go(`/t/${TOKEN}`, boom)).status, 503);
  assert.equal((await go(`/t/${TOKEN}`, deps(() => new Response("", { status: 500 })))).status, 503);
  assert.equal((await go(`/t/${TOKEN}`, { demo: false, internal: null })).status, 503);
});

test("only GET / HEAD", async () => {
  const res = await go(`/t/${TOKEN}`, ok(), "POST");
  assert.equal(res.status, 405);
  assertPrivate(res);
  const head = await go(`/t/${TOKEN}`, ok(), "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("demo needs no lp-tickets", async () => {
  const d: PassDeps = { demo: true, internal: null };
  assert.equal((await go("/t/demo", d)).status, 200);
  assert.equal((await go("/t/demo/qr.png", d)).headers.get("content-type"), "image/png");
  assert.equal((await go(`/t/${TOKEN}`, d)).status, 404);
});

test("escapes what comes from lp-tickets", () => {
  const html = renderPassPage({ ...PASS, ticketTypeName: "<script>alert(1)</script>" }, TOKEN);
  assert.ok(!html.includes("<script>alert(1)"));
});

function decodePng(bytes: Uint8Array) {
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  const idat: Uint8Array[] = [];
  const types: string[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.slice(at + 4, at + 8));
    types.push(type);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      assert.equal(bytes[at + 16], 1, "bit depth");
      assert.equal(bytes[at + 17], 0, "grayscale");
    }
    if (type === "IDAT") idat.push(bytes.slice(at + 8, at + 8 + len));
    at += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(width / 8);
  const dark = (x: number, y: number) => ((raw[y * (stride + 1) + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1) === 0;
  return { width, dark };
}

test("qr.png encodes the /t URL of this origin, matrix for matrix", async () => {
  const res = await go(`/t/${TOKEN}/qr.png`, ok());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assertPrivate(res);
  const png = new Uint8Array(await res.arrayBuffer());
  assert.ok(png.length < 4000, `png is ${png.length} bytes`);
  const { width, dark } = decodePng(png);
  const matrix = qrMatrix(`https://lp.example/t/${TOKEN}`);
  const scale = 6;
  const quiet = 4;
  assert.equal(width, (matrix.length + quiet * 2) * scale);
  assert.equal(dark(0, 0), false, "quiet zone");
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      assert.equal(dark((c + quiet) * scale + 2, (r + quiet) * scale + 2), matrix[r]![c], `${r},${c}`);
    }
  }
  // Finder pattern corners, so a broken encoder cannot pass by matching itself.
  assert.equal(matrix[0]![0], true);
  assert.equal(matrix[0]![matrix.length - 1], true);
  assert.equal(matrix[matrix.length - 1]![0], true);
  assert.equal(matrix[1]![1], false);
});

test("matrixToPng handles a width that is not a multiple of 8", async () => {
  const { width, dark } = decodePng(await matrixToPng([[true]]));
  assert.equal(width, 54);
  assert.equal(dark(24, 24), true);
  assert.equal(dark(30, 30), false);
});

// worker/index.ts itself, so route ordering is tested rather than assumed. Its JSON import needs an attribute in Node.
registerHooks({
  load(url, context, next) {
    return next(url, url.endsWith(".json") ? { ...context, importAttributes: { type: "json" } } : context);
  },
});

function workerEnv(passAnswer: () => Response) {
  const calls = { assets: 0, flag: 0, tickets: [] as string[] };
  const env = {
    ASSETS: {
      fetch: async () => {
        calls.assets++;
        return new Response("asset", { status: 404 });
      },
    },
    LP_FLAG: {
      fetch: async () => {
        calls.flag++;
        return Response.json({});
      },
    },
    LP_TICKETS: {
      fetch: async (input: Request | string) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        calls.tickets.push(path);
        return path.includes("/pass/") ? passAnswer() : Response.json({ enabled: false, types: [], fields: [] });
      },
    },
  };
  return { env, calls };
}

test("worker: /t works with sales off, ahead of every other route, and sets no cookie", async () => {
  const { default: worker } = await import("./index.ts");
  const { env, calls } = workerEnv(() => Response.json(PASS));
  for (const path of [`/t/${TOKEN}`, `/t/${TOKEN}?version=3.1&tickets=on`]) {
    const res = await worker.fetch(new Request(`https://lp.example${path}`), env as never);
    assert.equal(res.status, 200);
    assertPrivate(res);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok((await res.text()).includes("ABCD1234"));
  }
  const qr = await worker.fetch(new Request(`https://lp.example/t/${TOKEN}/qr.png`), env as never);
  assert.equal(qr.headers.get("content-type"), "image/png");
  assert.equal(calls.assets, 0);
  assert.equal(calls.flag, 0);
  assert.ok(calls.tickets.every((p) => p.startsWith("/lp/internal/tickets/pass/")));
});

test("worker: an unknown ticket is a plain 404, never the LP's asset 404", async () => {
  const { default: worker } = await import("./index.ts");
  const { env, calls } = workerEnv(() => new Response("{}", { status: 404 }));
  const res = await worker.fetch(new Request(`https://lp.example/t/${TOKEN}`), env as never);
  assert.equal(res.status, 404);
  assert.equal(calls.assets, 0);
  assertPrivate(res);
});

test("worker: paths that merely start with /t still reach the LP", async () => {
  const { default: worker } = await import("./index.ts");
  const { env, calls } = workerEnv(() => Response.json(PASS));
  await worker.fetch(new Request("https://lp.example/talks"), env as never);
  assert.ok(calls.assets > 0);
});
