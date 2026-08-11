// Inbox ⇄ Sent folder switch. A thin wrapper over @dub/ui Tabs that drives shell
// navigation (SPA, no reload) between the two API-wired mail folders. Rendered atop
// InboxScreen (/mail/inbox) and SentScreen (/mail/sent) so the mail UI reads like a
// Gmail-style two-folder mailbox. Navigation goes through the shell router's
// useNavigate so in-app state (e.g. a just-sent message in the demo transport)
// survives the switch.
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@dub/ui";

const FOLDERS = [
  { id: "inbox", label: "受信トレイ", path: "/mail/inbox" },
  { id: "sent", label: "送信済み", path: "/mail/sent" },
] as const;

export function MailFolderTabs({ active }: { active: "inbox" | "sent" }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Tabs
      testId="fe2-mail-folders"
      activeId={active}
      items={FOLDERS.map((f) => ({ id: f.id, label: f.label }))}
      onChange={(id) => {
        const target = FOLDERS.find((f) => f.id === id);
        if (target && id !== active) void navigate({ to: target.path });
      }}
    />
  );
}
