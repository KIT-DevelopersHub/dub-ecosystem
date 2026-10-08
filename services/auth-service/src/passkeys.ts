// Passkey (WebAuthn) ceremonies. Verification is delegated to @simplewebauthn/server
// (WebCrypto-only, runs on Workers) — origin / rpId / challenge / signature / UV / counter
// regression are all checked there; this module owns the parts the library cannot:
//
//   - challenges: server-stored in identity D1, SINGLE-USE (atomic DELETE ... RETURNING
//     before verification), 5-minute TTL, and bound to a ceremony kind (+ user for
//     registration) so a login challenge can't complete a registration or vice versa.
//     Not KV: the public login/options route would let an anonymous caller burn the KV
//     free-tier write quota (1,000/day) that sessions depend on.
//   - registration is only reachable from an authenticated session AND after a fresh
//     password re-entry (step-up): the challenge is minted only once the password
//     verified, and it carries the session's userId, so it cannot be redeemed for anyone
//     else. This is what stops a stolen cookie from silently planting an attacker's
//     authenticator on the account.
//   - userHandle in an assertion must name the credential's owner (no credential/user
//     confusion between accounts).
//
// Credentials live in identity (identity_webauthn_credentials) behind PasskeyStore.
import type { RequestContext } from "@dub/http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type { AppConfig } from "./env";
import type { PasskeyRecord, PasskeyStore, StoredChallenge } from "./identity-client";

/** Challenge lifetime. Comfortably above a slow Touch ID prompt; KV floor is 60s. */
export const CHALLENGE_TTL_SEC = 300;

/** Why a ceremony failed. Never sent to the client (it gets a generic error); audit only. */
export type PasskeyFailure =
  | "challenge_invalid"
  | "challenge_mismatch"
  | "unknown_credential"
  | "user_handle_mismatch"
  | "verification_failed"
  | "duplicate";

export class PasskeyError extends Error {
  constructor(readonly reason: PasskeyFailure) {
    super(reason);
  }
}

export interface RegisteredPasskey {
  record: PasskeyRecord;
}

export interface VerifiedLogin {
  userId: string;
  credentialId: string;
}

/** Wire shape returned to the SPA for the management UI (no key material). */
export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

export function toSummary(r: PasskeyRecord): PasskeySummary {
  return { id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, backedUp: r.backedUp };
}

/** Pull the challenge out of a client response without trusting anything else in it. */
function challengeOf(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string") return null;
  try {
    const parsed = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as { challenge?: unknown };
    return typeof parsed.challenge === "string" && parsed.challenge ? parsed.challenge : null;
  } catch {
    return null;
  }
}

export class PasskeyService {
  constructor(
    private readonly store: PasskeyStore,
    private readonly rp: NonNullable<AppConfig["webauthn"]>,
  ) {}

  /** Atomic take: a challenge is redeemable exactly once, success or not. */
  private async takeChallenge(ctx: RequestContext, clientDataJSON: unknown): Promise<{ challenge: string; rec: StoredChallenge }> {
    const challenge = challengeOf(clientDataJSON);
    if (!challenge) throw new PasskeyError("challenge_invalid");
    const rec = await this.store.takeChallenge(ctx, challenge);
    if (!rec) throw new PasskeyError("challenge_invalid");
    return { challenge, rec };
  }

  /** Step 1 of registration. Caller MUST have verified the session and the step-up password. */
  async registrationOptions(
    ctx: RequestContext,
    user: { id: string; email: string; displayName: string },
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.store.listPasskeys(ctx, user.id);
    const options = await generateRegistrationOptions({
      rpName: this.rp.rpName,
      rpID: this.rp.rpId,
      userID: isoUint8Array.fromUTF8String(user.id),
      userName: user.email,
      userDisplayName: user.displayName || user.email,
      attestationType: "none",
      // Same authenticator twice is refused client-side before the user is even prompted.
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })),
      // Discoverable (usernameless login) + UV: a passkey replaces the password, so it
      // must itself be possession + biometric/PIN, not possession alone.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: CHALLENGE_TTL_SEC * 1000,
    });
    await this.store.saveChallenge(ctx, options.challenge, { kind: "register", userId: user.id }, CHALLENGE_TTL_SEC);
    return options;
  }

  /** Step 2 of registration. `sessionUserId` is the CURRENT session's user, re-checked here. */
  async verifyRegistration(
    ctx: RequestContext,
    sessionUserId: string,
    response: RegistrationResponseJSON,
    label: string,
  ): Promise<RegisteredPasskey> {
    const { challenge, rec } = await this.takeChallenge(ctx, response?.response?.clientDataJSON);
    // A challenge minted for user A can never be redeemed by user B's session.
    if (rec.kind !== "register" || rec.userId !== sessionUserId) throw new PasskeyError("challenge_mismatch");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.rp.origins,
        expectedRPID: this.rp.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new PasskeyError("verification_failed");
    }
    if (!verification.verified || !verification.registrationInfo) throw new PasskeyError("verification_failed");
    const info = verification.registrationInfo;
    const record = await this.store.createPasskey(ctx, sessionUserId, {
      id: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      signCount: info.credential.counter,
      transports: info.credential.transports ?? response.response.transports ?? [],
      aaguid: info.aaguid || null,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      label,
    });
    if (!record) throw new PasskeyError("duplicate");
    return { record };
  }

  /** Step 1 of login. Usernameless: no allowCredentials, the authenticator picks. */
  async loginOptions(ctx: RequestContext): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.rp.rpId,
      userVerification: "required",
      timeout: CHALLENGE_TTL_SEC * 1000,
    });
    await this.store.saveChallenge(ctx, options.challenge, { kind: "login", userId: null }, CHALLENGE_TTL_SEC);
    return options;
  }

  /** Step 2 of login. Returns the authenticated user; the caller mints the session. */
  async verifyLogin(ctx: RequestContext, response: AuthenticationResponseJSON): Promise<VerifiedLogin> {
    const { challenge, rec } = await this.takeChallenge(ctx, response?.response?.clientDataJSON);
    if (rec.kind !== "login") throw new PasskeyError("challenge_mismatch");
    const credentialId = typeof response.id === "string" ? response.id : "";
    const cred = credentialId ? await this.store.getPasskey(ctx, credentialId) : null;
    if (!cred) throw new PasskeyError("unknown_credential");
    // The authenticator states whose passkey this is; it must agree with our records.
    const handle = response.response.userHandle;
    if (handle) {
      let owner: string | null = null;
      try {
        owner = isoBase64URL.toUTF8String(handle);
      } catch {
        owner = null;
      }
      if (owner !== cred.userId) throw new PasskeyError("user_handle_mismatch");
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.rp.origins,
        expectedRPID: this.rp.rpId,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: cred.signCount,
          transports: cred.transports as AuthenticatorTransportFuture[],
        },
      });
    } catch {
      // Includes the library's counter-regression rejection (cloned authenticator).
      throw new PasskeyError("verification_failed");
    }
    if (!verification.verified) throw new PasskeyError("verification_failed");
    await this.store.recordPasskeyUse(ctx, cred.id, verification.authenticationInfo.newCounter);
    return { userId: cred.userId, credentialId: cred.id };
  }
}
