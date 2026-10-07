// Minimal software WebAuthn authenticator (ES256, attestation "none") so the passkey
// tests drive the REAL @simplewebauthn/server verification path end to end — no mocks of
// the cryptography. It produces exactly what a browser hands back from
// navigator.credentials.create()/get() after @simplewebauthn/browser JSON-encodes it.
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as BufferSource));
}

function cat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** WebCrypto ECDSA emits raw r||s; WebAuthn signatures are ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = cat([new Uint8Array([0]), v]);
    return cat([new Uint8Array([0x02, v.length]), v]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return cat([new Uint8Array([0x30, r.length + s.length]), r, s]);
}

export interface SoftAuthenticatorOptions {
  rpId: string;
  origin: string;
  /** Drop the UV flag (simulates a security key without PIN/biometric). */
  noUserVerification?: boolean;
  /** Always report counter 0 (iCloud Keychain / Google Password Manager behaviour). */
  zeroCounter?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
  counter = 0;
  userHandle: string | null = null;
  private keys!: CryptoKeyPair;

  constructor(private readonly opts: SoftAuthenticatorOptions) {}

  private flags(attested: boolean): number {
    const UP = 0x01;
    const UV = this.opts.noUserVerification ? 0 : 0x04;
    return UP | UV | (attested ? 0x40 : 0);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin?: string): Uint8Array<ArrayBuffer> {
    return cat([enc.encode(JSON.stringify({ type, challenge, origin: origin ?? this.opts.origin, crossOrigin: false }))]);
  }

  /** navigator.credentials.create() for the given server options. */
  async create(options: { challenge: string; user: { id: string } }, over: { rpId?: string; origin?: string } = {}) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]),
    );
    const credId = isoBase64URL.toBuffer(this.credentialId);
    const authData = cat([
      await sha256(enc.encode(over.rpId ?? this.opts.rpId)),
      new Uint8Array([this.flags(true)]),
      u32(this.counter),
      new Uint8Array(16), // aaguid (all zero = "none")
      new Uint8Array([(credId.length >> 8) & 0xff, credId.length & 0xff]),
      credId,
      cose,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    this.userHandle = options.user.id;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(this.clientData("webauthn.create", options.challenge, over.origin)),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(). `counterStep` 0 keeps the counter (cloned-key simulation). */
  async get(options: { challenge: string }, over: { origin?: string; rpId?: string; counterStep?: number; userHandle?: string } = {}) {
    if (!this.opts.zeroCounter) this.counter += over.counterStep ?? 1;
    const authData = cat([
      await sha256(enc.encode(over.rpId ?? this.opts.rpId)),
      new Uint8Array([this.flags(false)]),
      u32(this.counter),
    ]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, over.origin);
    const signed = cat([authData, await sha256(clientDataJSON)]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed as unknown as BufferSource),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(rawToDer(raw)),
        userHandle: over.userHandle ?? this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
    };
  }
}
