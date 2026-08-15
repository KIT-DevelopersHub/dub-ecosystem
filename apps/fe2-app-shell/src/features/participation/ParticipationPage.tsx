// 参加届 screen (in-shell, for signed-in 運営). Renders the shared ParticipationForm
// under the standard PageHeader/Card chrome. Submission itself is public (the form posts
// to the gateway's unauthenticated /public/participation endpoint) and reflects onto the
// 運営メンバー名簿 server-side. Anonymous participants use the standalone public page.
import { PageHeader } from "@dub/ui";
import { ParticipationForm } from "./ParticipationForm.tsx";
import { PUBLIC_PARTICIPATION_PATH } from "./module.tsx";
import styles from "./participation.module.css";

export function ParticipationPage(): JSX.Element {
  return (
    <div data-testid="participation-page">
      <PageHeader
        title="参加届"
        description="運営メンバーとして参加する届出です。送信すると運営メンバー名簿に反映されます。"
      />
      <p className={styles.shareHint} data-testid="participation-public-link">
        参加者に共有するときは、ログイン不要の公開フォーム{" "}
        <a href={PUBLIC_PARTICIPATION_PATH} target="_blank" rel="noreferrer">
          {PUBLIC_PARTICIPATION_PATH}
        </a>{" "}
        を案内してください（このページと同じフォームです）。
      </p>
      <ParticipationForm />
    </div>
  );
}
