// Mail feature — public surface for the shell composition (featureModules.tsx).
export { createMailApi, parseRecipients, isValidEmail } from "./mailApi.tsx";
export type { MailApi, InboxQuery, SentQuery } from "./mailApi.tsx";
export { MailProvider, MailApiProvider, useMailApi } from "./MailProvider.tsx";
export { InboxScreen } from "./InboxScreen.tsx";
export { SentScreen } from "./SentScreen.tsx";
export { MailFolderTabs } from "./MailFolderTabs.tsx";
export { ThreadDetail } from "./MessageDetail.tsx";
export { sanitizeHtml } from "./sanitize.tsx";
export { ComposeScreen } from "./ComposeScreen.tsx";
// Gmail-style experience (the /mail route). Client-side store + 3-pane UI.
export { GmailApp } from "./gmail/GmailApp.tsx";
export { MailStoreProvider, useMailStore, reducer as mailReducer, initialMailState } from "./gmail/useMailStore.tsx";
export type { MailState, MailAction, ComposeState } from "./gmail/useMailStore.tsx";
export { mailRoutes, mailNav } from "./module.tsx";
export type { MailSourceRoute, MailNavEntry } from "./module.tsx";
