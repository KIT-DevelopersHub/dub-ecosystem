import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import { validateUnfurlUrl, parseOgp, createUnfurler, decodeEntities } from "../src/unfurl";

describe("validateUnfurlUrl (SSRF guard)", () => {
  it.each([
    "https://github.com/KIT-DevelopersHub/dub-ecosystem",
    "http://example.com/a?b=c#frag",
    "https://zenn.dev:443/topics/cloudflare",
  ])("allows public http(s) %s", (u) => {
    expect(validateUnfurlUrl(u)).not.toBeNull();
  });

  it.each([
    "ftp://example.com/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pw@example.com/",
    "https://example.com:9200/",
    "http://localhost/",
    "http://foo.localhost/",
    "http://intranet/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.20.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://svc.internal/",
    "not a url",
  ])("blocks %s", (u) => {
    expect(validateUnfurlUrl(u)).toBeNull();
  });

  it("strips the fragment", () => {
    expect(validateUnfurlUrl("https://example.com/p#x")?.toString()).toBe("https://example.com/p");
  });
});

describe("parseOgp", () => {
  const html = `<!doctype html><html><head>
    <title>Fallback &amp; title</title>
    <meta property="og:site_name" content="GitHub">
    <meta content="Dub ecosystem" property="og:title">
    <meta property="og:description" content="DevHub &quot;monorepo&quot;">
    <meta property="og:image" content="/img/card.png">
  </head><body>ignored</body></html>`;

  it("extracts og:* with either attribute order, decodes entities, absolutizes the image", () => {
    expect(parseOgp(html, "https://github.com/x/y")).toEqual({
      url: "https://github.com/x/y",
      siteName: "GitHub",
      title: "Dub ecosystem",
      description: 'DevHub "monorepo"',
      imageUrl: "https://github.com/img/card.png",
    });
  });

  it("falls back to <title> and hostname; null when no title at all", () => {
    const p = parseOgp("<html><head><title>Plain &amp; simple</title></head></html>", "https://www.example.com/a");
    expect(p?.title).toBe("Plain & simple");
    expect(p?.siteName).toBe("example.com");
    expect(p?.imageUrl).toBeNull();
    expect(parseOgp("<html><body>no head</body></html>", "https://example.com/")).toBeNull();
  });

  it("drops non-http image URLs", () => {
    const p = parseOgp('<meta property="og:title" content="t"><meta property="og:image" content="javascript:x">', "https://e.com/");
    expect(p?.imageUrl).toBeNull();
  });

  it("decodes numeric entities", () => {
    expect(decodeEntities("a&#39;b&#x41;")).toBe("a'bA");
  });
});

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = routes[href];
    if (!handler) return new Response("nf", { status: 404 });
    return handler();
  }) as typeof fetch;
}
const htmlRes = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("createUnfurler", () => {
  it("resolves a preview, following a public redirect", async () => {
    const unfurl = createUnfurler({
      fetchImpl: fakeFetch({
        "https://a.example/": () => new Response(null, { status: 301, headers: { location: "https://b.example/page" } }),
        "https://b.example/page": () => htmlRes('<meta property="og:title" content="B page">'),
      }),
    });
    const p = await unfurl("https://a.example/");
    expect(p?.title).toBe("B page");
    expect(p?.url).toBe("https://b.example/page");
  });

  it("blocks a redirect into a private host", async () => {
    const unfurl = createUnfurler({
      fetchImpl: fakeFetch({
        "https://a.example/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      }),
    });
    expect(await unfurl("https://a.example/")).toBeNull();
  });

  it("returns null on too many redirects, non-HTML, non-2xx and thrown errors", async () => {
    const loop = () => new Response(null, { status: 302, headers: { location: "https://a.example/" } });
    expect(await createUnfurler({ fetchImpl: fakeFetch({ "https://a.example/": loop }), maxRedirects: 2 })("https://a.example/")).toBeNull();
    expect(
      await createUnfurler({ fetchImpl: fakeFetch({ "https://a.example/": () => new Response("{}", { headers: { "content-type": "application/json" } }) }) })(
        "https://a.example/",
      ),
    ).toBeNull();
    expect(await createUnfurler({ fetchImpl: fakeFetch({}) })("https://a.example/")).toBeNull();
    expect(
      await createUnfurler({
        fetchImpl: (async () => {
          throw new Error("boom");
        }) as typeof fetch,
      })("https://a.example/"),
    ).toBeNull();
  });

  it("caps the bytes read", async () => {
    const big = `<meta property="og:title" content="early">${"x".repeat(100_000)}<meta property="og:description" content="late">`;
    const p = await createUnfurler({ fetchImpl: fakeFetch({ "https://a.example/": () => htmlRes(big) }), maxBytes: 1024 })("https://a.example/");
    expect(p?.title).toBe("early");
    expect(p?.description).toBeNull();
  });
});

describe("GET /chat/unfurl", () => {
  it("401 without a subject", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/chat/unfurl?url=https%3A%2F%2Fexample.com%2F", { userId: null });
    expect(res.status).toBe(401);
  });

  it("400 for a blocked/invalid url (never fetched)", async () => {
    let called = 0;
    const app = createApp(
      makeDeps({
        unfurler: async () => {
          called++;
          return null;
        },
      }),
    );
    const res = await call(app, "GET", "/chat/unfurl?url=http%3A%2F%2F127.0.0.1%2F");
    expect(res.status).toBe(400);
    expect(called).toBe(0);
  });

  it("200 with the preview (and null preview when nothing presentable)", async () => {
    const app = createApp(
      makeDeps({
        unfurler: async (url) =>
          url.startsWith("https://ok.example") ? { url, siteName: "OK", title: "T", description: null, imageUrl: null } : null,
      }),
    );
    const ok = await call(app, "GET", "/chat/unfurl?url=https%3A%2F%2Fok.example%2Fp");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ url: "https://ok.example/p", preview: { url: "https://ok.example/p", siteName: "OK", title: "T", description: null, imageUrl: null } });
    const none = await call(app, "GET", "/chat/unfurl?url=https%3A%2F%2Fno.example%2F");
    expect(none.json).toEqual({ url: "https://no.example/", preview: null });
  });

  it("200 with null preview when no unfurler is wired", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/chat/unfurl?url=https%3A%2F%2Fexample.com%2F");
    expect(res.status).toBe(200);
    expect(res.json.preview).toBeNull();
  });
});
