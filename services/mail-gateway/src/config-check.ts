// Startup / readiness self-check. Surfaces mis-provisioning BEFORE a send is attempted
// (the provider otherwise falls back to a loud stub that only fails at send time). Never
// echoes a secret VALUE — only booleans (present / absent) and non-secret config. Backs
// the internal /internal/health/ready endpoint so a deploy smoke-test can assert the
// service is actually wired for the intended provider.
import { DEFAULT_FROM_ADDRESS, DEFAULT_OUTBOUND_PROVIDER, OUTBOUND_PROVIDERS } from "./config";
import type { Env } from "./env";
import { mailchannelsConfigFromEnv } from "./mailchannels";
import { parseMaxAttempts, parseTimeoutMs } from "./resilience";
import { resendConfigFromEnv } from "./resend";
import { sesConfigFromEnv } from "./ses";

export interface ProviderReadiness {
  provider: string; // configured MAIL_OUTBOUND_PROVIDER (lower-cased)
  known: boolean; // a recognized provider name (ses/mailchannels/resend/mock)
  credentialsPresent: boolean; // real credentials found (mock => always true)
  fromAddress: string; // effective From (never a secret)
  region?: string; // SES region when relevant
  ready: boolean; // credentialsPresent && known && no validation issues
  issues: string[]; // human-readable, secret-free
}

const KNOWN = new Set<string>([...OUTBOUND_PROVIDERS, "mock"]);

/** True when the selected provider has enough config to actually send (no secret leak). */
export function credentialsPresent(env: Env, provider: string): boolean {
  switch (provider) {
    case "mock":
      return true;
    case "ses":
      return sesConfigFromEnv(env) !== null;
    case "mailchannels":
      return mailchannelsConfigFromEnv(env) !== null;
    case "resend":
      return resendConfigFromEnv(env) !== null;
    default:
      return false;
  }
}

/** Non-secret validation issues (unknown provider, missing creds, bad From). */
export function validateEnv(env: Env): string[] {
  const issues: string[] = [];
  const provider = (env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase();

  if (!KNOWN.has(provider)) {
    issues.push(`MAIL_OUTBOUND_PROVIDER="${provider}" is not one of ${[...KNOWN].join("/")} (falls back to ${DEFAULT_OUTBOUND_PROVIDER})`);
  }
  if (KNOWN.has(provider) && provider !== "mock" && !credentialsPresent(env, provider)) {
    issues.push(`${provider} selected but its credentials/secrets are absent — sends will fail with a loud stub`);
  }
  const from = env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    issues.push(`MAIL_FROM_ADDRESS="${from}" is not a valid email address`);
  }
  return issues;
}

/** Readiness snapshot for /internal/health/ready. Secret-free. */
export function providerReadiness(env: Env): ProviderReadiness {
  const provider = (env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase();
  const known = KNOWN.has(provider);
  const creds = known && credentialsPresent(env, provider);
  const issues = validateEnv(env);
  const out: ProviderReadiness = {
    provider,
    known,
    credentialsPresent: creds,
    fromAddress: env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS,
    ready: creds && known && issues.length === 0,
    issues,
  };
  if (provider === "ses") out.region = sesConfigFromEnv(env)?.region ?? env.SES_REGION ?? "ap-northeast-1";
  return out;
}

/** Non-secret effective tuning (for the readiness endpoint / ops visibility). */
export function effectiveTuning(env: Env): { maxAttempts: number; timeoutMs: number } {
  return { maxAttempts: parseMaxAttempts(env), timeoutMs: parseTimeoutMs(env) };
}
