// 参加届 PUBLIC standalone page. Mounted OUTSIDE the authenticated app shell (sibling of
// /login, not wrapped in RequireAuth), so an anonymous participant can reach and submit
// it without signing in. It builds its own ParticipationProvider from the shell api-client
// (QueryClient / Toast come from AppRoot, which wraps the whole router) and renders the
// shared ParticipationForm in a minimal, chrome-free layout. Management/閲覧 stays inside
// the shell (運営 only); only the form submission is opened to unauthenticated callers.
import type { ApiClient } from "../../lib/api-client.tsx";
import { ParticipationProvider } from "./ParticipationProvider.tsx";
import { ParticipationForm } from "./ParticipationForm.tsx";
import styles from "./participation.module.css";

export function PublicParticipationPage({ api }: { api: ApiClient }): JSX.Element {
  return (
    <ParticipationProvider api={api}>
      <div className={styles.publicPage} data-testid="participation-public-page">
        <div className={styles.publicInner}>
          <header className={styles.publicHeader}>
            <h1 className={styles.publicTitle}>参加届</h1>
            <p className={styles.publicLead}>
              運営メンバーとして参加するための届出フォームです。ログインは不要です。
              学校のメールアドレスと Gmail アドレスの両方をご記入ください。
            </p>
          </header>
          <ParticipationForm />
        </div>
      </div>
    </ParticipationProvider>
  );
}
