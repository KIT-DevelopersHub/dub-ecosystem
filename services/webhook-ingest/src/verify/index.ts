// Verifier registry keyed by source, and secret assembly from Env.
import type { webhook } from "@dub/types";
import type { Env } from "../env";
import { verifyGithub } from "./github";
import { verifyGoogleDrive, verifyGmail, verifyStripe } from "./stubs";
import type { Verifier, VerifierSecrets } from "./types";

export const VERIFIERS: Record<webhook.WebhookSource, Verifier> = {
  github: verifyGithub,
  "google-drive": verifyGoogleDrive,
  gmail: verifyGmail,
  stripe: verifyStripe,
};

export function secretsFromEnv(env: Env): VerifierSecrets {
  return {
    github: [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_NEXT],
    driveTokens: [env.DRIVE_WEBHOOK_TOKEN, env.DRIVE_WEBHOOK_TOKEN_NEXT],
    stripe: [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_NEXT],
    ...(env.GMAIL_WEBHOOK_AUDIENCE ? { gmailAudience: env.GMAIL_WEBHOOK_AUDIENCE } : {}),
    ...(env.GMAIL_PUSH_SA_EMAIL ? { gmailServiceAccountEmail: env.GMAIL_PUSH_SA_EMAIL } : {}),
  };
}

export * from "./types";
