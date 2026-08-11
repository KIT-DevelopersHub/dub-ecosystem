// Mail FeatureModule source (authored against FE2's canonical contract, like
// FE3–FE7). The shell's composition (featureModules.tsx) wraps these routes in
// MailProvider fed by the one api-client and merges the nav ordering. Two routes:
//   /mail          → inbox (mail:read)
//   /mail/compose  → compose+send (mail:send)
// Both are auth:"required" so an unauthenticated visitor is bounced to /login by
// the shell — no per-request token, the session authorizes everything.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { GmailApp } from "./gmail/GmailApp.tsx";
import { ComposeScreen } from "./ComposeScreen.tsx";
import { InboxScreen } from "./InboxScreen.tsx";
import { SentScreen } from "./SentScreen.tsx";

type PermissionKey = identity.PermissionKey;

export interface MailSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface MailNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const mailRoutes: MailSourceRoute[] = [
  // /mail renders the Gmail-style 3-pane experience (list ↔ reading pane, left
  // folder/label nav, floating compose). It carries its own compose affordance,
  // so no navigation to a separate compose route is needed.
  { path: "/mail", lazy: () => Promise.resolve({ Component: GmailApp }), auth: "required", requiredPermissions: ["mail:read"] },
  // API-wired folder pair (Inbox / Sent) sharing the MailFolderTabs switch. These read
  // the live gateway (GET /mail/messages, GET /mail/sent) so sent mail is visible; the
  // /mail 3-pane GmailApp above stays the rich client-side experience.
  { path: "/mail/inbox", lazy: () => Promise.resolve({ Component: InboxScreen }), auth: "required", requiredPermissions: ["mail:read"] },
  { path: "/mail/sent", lazy: () => Promise.resolve({ Component: SentScreen }), auth: "required", requiredPermissions: ["mail:read"] },
  // Standalone compose route retained for deep-links / mail:send gating.
  { path: "/mail/compose", lazy: () => Promise.resolve({ Component: ComposeScreen }), auth: "required", requiredPermissions: ["mail:send"] },
];

export const mailNav: MailNavEntry[] = [{ label: "メール", path: "/mail", icon: "inbox" }];
