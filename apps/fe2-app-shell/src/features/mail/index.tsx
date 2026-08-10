// Mail feature — public surface for the shell composition (featureModules.tsx).
export { createMailApi, parseRecipients, isValidEmail } from "./mailApi.tsx";
export type { MailApi, InboxQuery } from "./mailApi.tsx";
export { MailProvider, MailApiProvider, useMailApi } from "./MailProvider.tsx";
export { InboxScreen } from "./InboxScreen.tsx";
export { ComposeScreen } from "./ComposeScreen.tsx";
export { mailRoutes, mailNav } from "./module.tsx";
export type { MailSourceRoute, MailNavEntry } from "./module.tsx";
