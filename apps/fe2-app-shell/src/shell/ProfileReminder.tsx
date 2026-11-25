// プロフィール未入力のリマインド (#849)。アカウント設定の「本人の情報」に未入力の項目がある人へ、
// Dub を開くたびにヘッダーのバナーと ⚙ の点で知らせる。どの項目を必須とみなすかは
// @dub/types の PROFILE_REMINDER_KEYS (missingSelfProfileKeys) だけが決める。
//
// - 判定はクライアント側: 既存の GET /me/participation をアカウント設定と同じキャッシュキーで読む。
//   保存は楽観的にこのキャッシュを書き換えるので、入力が揃った瞬間にバナーも点も消える。
// - バナーの「あとで」はこのタブのセッションだけ閉じる (sessionStorage)。⚙ の点は残す。
// - 代理表示中は出さない (表示中の相手の情報で本人を急かさない)。
// - 読み込み中・取得失敗は何も出さない (中身の一覧ではなく条件付きの案内なので、
//   スケルトンを出すと入力済みの人にもちらつく)。
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, IconButton } from "@dub/ui";
import { member } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import styles from "./ProfileReminder.module.css";

/** 本人の参加届 (アカウント設定と共有のキャッシュキー)。 */
export const SELF_PARTICIPATION_KEY = queryKeys.feature("me-participation");

const DISMISS_KEY = "dub.profileReminder.dismissed";
/** バナーに並べる項目名の上限 (超えたら「ほか N 件」)。 */
const MAX_LISTED = 3;

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ストレージ不可 (プライベートモード等) でも、このマウント中は閉じたままにする。
  }
}

/** 未入力の項目 (表示順)。読み込み前・失敗・代理表示中・未ログインは空。 */
export function useMissingProfileKeys(api: Pick<ApiClient, "auth"> | undefined): member.PersonProfileKey[] {
  const auth = useAuth();
  const enabled = Boolean(api) && auth.status === "authenticated" && !auth.me.impersonation;
  const q = useQuery({
    queryKey: SELF_PARTICIPATION_KEY,
    queryFn: () => api!.auth.getSelfParticipation(),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  if (!enabled || !q.data) return [];
  return member.missingSelfProfileKeys(q.data);
}

/** 「〇〇、〇〇、〇〇 ほか N 件」 */
export function summarizeMissing(keys: readonly member.PersonProfileKey[]): string {
  const labels = keys.slice(0, MAX_LISTED).map((k) => member.PERSON_PROFILE_LABEL[k]);
  const rest = keys.length - labels.length;
  return rest > 0 ? `${labels.join("、")} ほか ${rest} 件` : labels.join("、");
}

export function ProfileReminderBanner({
  missing,
  onOpenSettings,
}: {
  missing: readonly member.PersonProfileKey[];
  onOpenSettings: () => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (missing.length === 0 || dismissed) return null;
  return (
    <div className={styles.banner} role="status" aria-live="polite" data-testid="fe2-profile-reminder">
      <span className={styles.message}>
        <span className={styles.title}>プロフィールに未入力の項目があります。入力してください</span>
        <span className={styles.fields} data-testid="fe2-profile-reminder-fields">
          {summarizeMissing(missing)}
        </span>
      </span>
      <span className={styles.actions}>
        <Button variant="primary" size="sm" onClick={onOpenSettings} testId="fe2-profile-reminder-open">
          入力する
        </Button>
        <IconButton
          name="x"
          aria-label="あとで (このセッションでは表示しない)"
          size="sm"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          testId="fe2-profile-reminder-dismiss"
        />
      </span>
    </div>
  );
}
