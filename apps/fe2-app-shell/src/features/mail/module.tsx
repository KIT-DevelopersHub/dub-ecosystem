// Mail FeatureModule source (authored against FE2's canonical contract, like
// FE3–FE7). The shell's composition (featureModules.tsx) wraps these routes in
// MailProvider fed by the one api-client and merges the nav ordering. Two routes:
//   /mail          → inbox (mail:read)
//   /mail/compose  → compose+send (mail:send)
// Both are auth:"required" so an unauthenticated visitor is bounced to /login by
// the shell — no per-request token, the session authorizes everything.
import { createElement } from "react";
import type { ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { InboxScreen } from "./InboxScreen.tsx";
import { ComposeScreen } from "./ComposeScreen.tsx";

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

/** Inbox wired to the shell router so its "compose" affordance navigates. */
function InboxRoute(): JSX.Element {
  const navigate = useNavigate();
  return createElement(InboxScreen, { onCompose: () => void navigate({ to: "/mail/compose" }) });
}

export const mailRoutes: MailSourceRoute[] = [
  { path: "/mail", lazy: () => Promise.resolve({ Component: InboxRoute }), auth: "required", requiredPermissions: ["mail:read"] },
  { path: "/mail/compose", lazy: () => Promise.resolve({ Component: ComposeScreen }), auth: "required", requiredPermissions: ["mail:send"] },
];

export const mailNav: MailNavEntry[] = [{ label: "メール", path: "/mail", icon: "inbox" }];
