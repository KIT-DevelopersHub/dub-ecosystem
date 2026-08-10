// Gmail Pub/Sub push OIDC verifier: real RS256 JWT verification against an injected
// JWKS (fake fetch), covering sig / iss / aud / exp and the "偽物を通さない" property.
import { describe, it, expect, beforeAll } from "vitest";
import { createGmailVerifier } from "../src/verify/gmail";

const AUD = "https://hooks.developershub.jp/hooks/gmail";
const SA_EMAIL = "gmail-push@dub-project.iam.gserviceaccount.com";
const KID = "test-key-1";
const enc = (s: string) => new TextEncoder().encode(s);

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jsonToB64url(o: unknown): string {
  return bytesToB64url(enc(JSON.stringify(o)));
}

async function genKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function publicJwk(pair: CryptoKeyPair, kid = KID): Promise<JsonWebKey & { kid: string }> {
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

async function signJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: KID },
): Promise<string> {
  const signingInput = `${jsonToB64url(header)}.${jsonToB64url(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

function jwksFetch(...jwks: JsonWebKey[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ keys: jwks }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function pubsubBody(messageId = "msg-1"): Uint8Array {
  return enc(
    JSON.stringify({
      message: { data: btoa("{}"), messageId, publishTime: "2026-08-09T00:00:00Z" },
      subscription: "projects/p/subscriptions/s",
    }),
  );
}

const NOW_MS = Date.parse("2026-08-09T00:00:00Z");
const nowSec = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;
const bearer = (jwt: string) => new Headers({ authorization: `Bearer ${jwt}` });
const validClaims = () => ({
  iss: "https://accounts.google.com",
  aud: AUD,
  exp: nowSec + 600,
  iat: nowSec,
  email: SA_EMAIL,
  email_verified: true,
});
const SECRETS = { gmailAudience: AUD, gmailServiceAccountEmail: SA_EMAIL };

describe("gmail OIDC verifier", () => {
  let pair: CryptoKeyPair;
  let jwk: JsonWebKey & { kid: string };

  beforeAll(async () => {
    pair = await genKeyPair();
    jwk = await publicJwk(pair);
  });

  it("accepts a valid Google-signed push and derives the message id as dedup key", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, validClaims());
    const res = await verify({ rawBytes: pubsubBody("msg-42"), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.externalId).toBe("msg-42");
      expect(res.eventKind).toBe("gmail.push");
    }
  });

  it("rejects a token forged with a different key (signature mismatch)", async () => {
    const attacker = await genKeyPair(); // signs, but JWKS still serves the real public key
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(attacker.privateKey, validClaims());
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong audience", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, { ...validClaims(), aud: "https://evil.example/hooks" });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong issuer", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, { ...validClaims(), iss: "https://evil.example" });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, { ...validClaims(), exp: nowSec - 3600, iat: nowSec - 7200 });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("fails closed when no audience is configured", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, validClaims());
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, {});
    expect(res.ok).toBe(false);
  });

  it("rejects a missing bearer token", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const res = await verify({ rawBytes: pubsubBody(), headers: new Headers() }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("rejects when the signing key id is unknown to the JWKS", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, validClaims(), { alg: "RS256", typ: "JWT", kid: "other-kid" });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  it("rejects when the pub/sub message id is absent", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, validClaims());
    const body = enc(JSON.stringify({ message: {}, subscription: "s" }));
    const res = await verify({ rawBytes: body, headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
  });

  // ---- service-account identity (aud alone is attacker-controllable) ----
  it("rejects a token whose email is not the configured service account", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    // Google-signed, right aud/iss/exp — but a different (attacker's own) SA identity.
    const jwt = await signJwt(pair.privateKey, {
      ...validClaims(),
      email: "attacker@evil.iam.gserviceaccount.com",
    });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("service account email mismatch");
  });

  it("rejects a token whose email is not verified (email_verified !== true)", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, { ...validClaims(), email_verified: false });
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("service account email not verified");
  });

  it("rejects a token missing the email_verified claim", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const { email_verified: _omit, ...noVerified } = validClaims();
    const jwt = await signJwt(pair.privateKey, noVerified);
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, SECRETS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("service account email not verified");
  });

  it("fails closed when no service account email is configured", async () => {
    const verify = createGmailVerifier({ fetch: jwksFetch(jwk), now });
    const jwt = await signJwt(pair.privateKey, validClaims());
    const res = await verify({ rawBytes: pubsubBody(), headers: bearer(jwt) }, { gmailAudience: AUD });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no gmail service account configured");
  });
});
