// STAGING ONLY: the fixed allowlist of seed/test accounts that the password-less
// demo-login may sign in as (debug menu account switcher). Used only when DEMO_AUTOLOGIN=1;
// in production neither demo route is registered, so this list is inert there.
//
// Only seed accounts belong here: infra/d1/seed/fixtures.ts (demo-*@dev.developershub.jp)
// and identity-roster DEMO_USERS (maintainer@ / member@). The oversight accounts
// (info@ / admin@, mail:read_all) are deliberately NOT listed. Each login still requires
// the email to be an ACTIVE roster user, and the list endpoint shows only those.

export interface DemoAccountSpec {
  email: string;
  label: string;
}

export const SEED_DEMO_ACCOUNTS: readonly DemoAccountSpec[] = [
  { email: "demo-organizer@dev.developershub.jp", label: "organizer" },
  { email: "demo-member@dev.developershub.jp", label: "member" },
  { email: "demo-outsider@dev.developershub.jp", label: "member（他組織）" },
  { email: "maintainer@developershub.jp", label: "maintainer" },
  { email: "member@developershub.jp", label: "member" },
];

const norm = (e: string): string => e.trim().toLowerCase();

/**
 * Default account first (label "admin"), then the seed list, then any extra emails from
 * DEMO_AUTOLOGIN_ACCOUNTS (comma-separated, staging var). De-duplicated by email.
 */
export function buildDemoAccounts(defaultEmail: string, extra: string | undefined): DemoAccountSpec[] {
  const out: DemoAccountSpec[] = [];
  const seen = new Set<string>();
  const add = (email: string, label: string): void => {
    const e = norm(email);
    if (!e || !e.includes("@") || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, label });
  };
  add(defaultEmail, "admin");
  for (const a of SEED_DEMO_ACCOUNTS) add(a.email, a.label);
  for (const e of (extra ?? "").split(",")) add(e, "custom");
  return out;
}
