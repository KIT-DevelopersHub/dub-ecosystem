// オンボーディング (運営メンバー・名簿 → オンボーディング タブ)。新しく入った人に最初に
// やってほしいことを並べ、ログイン不要の公開ページ (/onboarding) で共有する。項目の追加・
// 編集・削除・ドラッグ並び替えは 参加届アプリの「編集」、閲覧だけなら一覧と共有 URL のみ。
// 編集系は楽観的 UI (hooks.ts の useOnboardingMutation が失敗時にロールバック)。
// ミーティング (全体 / チームごと) は日時とリンクを登録し、案内ページの最後に表示する。
import { useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormField,
  Icon,
  IconButton,
  Modal,
  PageHeader,
  SkeletonList,
  SortableList,
  TextField,
  Textarea,
} from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { AppReadOnlyNotice } from "../../auth/AppReadOnlyNotice.tsx";
import {
  isPendingOnboardingItem,
  useCreateOnboardingItem,
  useDeleteOnboardingItem,
  useOnboardingItems,
  useReorderOnboardingItems,
  useSaveOnboardingMeeting,
  useUpdateOnboardingItem,
} from "./hooks.ts";
import {
  ONBOARDING_DESCRIPTION_MAX,
  ONBOARDING_SCHEDULE_MAX,
  ONBOARDING_TITLE_MAX,
  parseOnboardingItemInput,
  parseOnboardingMeetingInput,
  type OnboardingGuide,
  type OnboardingItem,
  type OnboardingItemInput,
  type OnboardingMeeting,
  type SaveOnboardingMeetingRequest,
} from "./contracts.ts";
import { PUBLIC_ONBOARDING_PATH } from "./module.tsx";
import { PublicUrlCard } from "./PublicUrlCard.tsx";
import styles from "./participation.module.css";

export function OnboardingAdminPage(): JSX.Element {
  const { canEdit } = useAppCapability("participation");
  const list = useOnboardingItems();
  const createMut = useCreateOnboardingItem();
  const updateMut = useUpdateOnboardingItem();
  const deleteMut = useDeleteOnboardingItem();
  const reorderMut = useReorderOnboardingItems();
  // null = 閉, "new" = 追加, item = 編集
  const [editing, setEditing] = useState<OnboardingItem | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OnboardingItem | null>(null);

  const items = list.data?.items ?? [];
  const hasPending = items.some(isPendingOnboardingItem);

  const onSave = (input: OnboardingItemInput): void => {
    if (editing === "new") createMut.mutate(input);
    else if (editing) updateMut.mutate({ id: editing.id, patch: input });
    setEditing(null);
  };

  let body: JSX.Element;
  if (list.isLoading) {
    body = <SkeletonList rows={3} testId="onboarding-admin-loading" />;
  } else if (list.isError) {
    const display = ApiError.isApiError(list.error)
      ? toDisplayableError(list.error)
      : { code: "UNKNOWN", message: "読み込みに失敗しました", retryable: true };
    body = <ErrorState error={display} onRetry={() => void list.refetch()} />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        title="まだ案内する項目はありません"
        description={canEdit ? "「項目を追加」から、新しく入った人にやってほしいことを登録してください" : "編集できる人が項目を登録すると、ここに表示されます"}
        icon="check-square"
        testId="onboarding-admin-empty"
      />
    );
  } else {
    body = (
      <SortableList<OnboardingItem>
        items={items}
        getItemId={(i) => i.id}
        disabled={!canEdit || hasPending || reorderMut.isPending || deleteMut.isPending}
        aria-label="案内する項目（ドラッグで並び替え）"
        testId="onboarding-admin-list"
        className={styles.onboardingList}
        onReorder={({ oldIndex, newIndex }) => {
          const ids = items.map((i) => i.id);
          const [moved] = ids.splice(oldIndex, 1);
          if (moved === undefined) return;
          ids.splice(newIndex, 0, moved);
          reorderMut.mutate(ids);
        }}
        renderItem={(item, ctx) => (
          <div
            className={styles.onboardingRow}
            data-dragging={ctx.isDragging || undefined}
            data-testid={`onboarding-admin-item-${item.id}`}
          >
            {canEdit ? (
              <span className={styles.dragHandle} aria-label="ドラッグして並び替え" {...ctx.dragHandleProps}>
                <Icon name="drag" />
              </span>
            ) : null}
            <span className={styles.stepNumber} aria-hidden>
              {items.indexOf(item) + 1}
            </span>
            <div className={styles.onboardingBody}>
              <div className={styles.onboardingTitle}>{item.title}</div>
              {item.description ? <p className={styles.onboardingDescription}>{item.description}</p> : null}
              {item.url ? (
                <a className={styles.onboardingLink} href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.url}
                </a>
              ) : null}
            </div>
            {canEdit ? (
              <div className={styles.onboardingActions}>
                <IconButton
                  name="edit"
                  aria-label={`「${item.title}」を編集`}
                  disabled={isPendingOnboardingItem(item)}
                  onClick={() => setEditing(item)}
                  testId={`onboarding-admin-edit-${item.id}`}
                />
                <IconButton
                  name="trash"
                  aria-label={`「${item.title}」を削除`}
                  disabled={isPendingOnboardingItem(item)}
                  onClick={() => setDeleteTarget(item)}
                  testId={`onboarding-admin-delete-${item.id}`}
                />
              </div>
            ) : null}
          </div>
        )}
      />
    );
  }

  return (
    <div className={styles.onboardingPage} data-testid="onboarding-admin-page">
      <AppReadOnlyNotice appId="participation" testId="onboarding-readonly-notice" />
      <PageHeader
        title="オンボーディング"
        description="新しく入った人に最初にやってほしいことをまとめ、ログイン不要の案内ページで共有します。"
      />

      <PublicUrlCard
        title="案内ページの URL"
        hint="このページはアプリのアカウントが無くても開けます。新しく入った人に送ってください。"
        path={PUBLIC_ONBOARDING_PATH}
        testId="onboarding-share"
      />

      <Card
        header={
          <div className={styles.sectionHeader}>
            <span>案内する項目</span>
            {canEdit ? (
              <Button size="sm" iconLeft={<Icon name="plus" />} onClick={() => setEditing("new")} testId="onboarding-admin-add">
                項目を追加
              </Button>
            ) : null}
          </div>
        }
        testId="onboarding-admin-items"
      >
        {canEdit && items.length > 1 ? (
          <p className={styles.sectionHint}>左端のつまみをドラッグすると、案内ページでの順番を入れ替えられます。</p>
        ) : null}
        {body}
      </Card>

      {list.data ? <MeetingsCard guide={list.data} canEdit={canEdit} /> : null}

      {editing !== null ? (
        <ItemDialog item={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onSave={onSave} />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="項目を削除する"
        message={deleteTarget ? `「${deleteTarget.title}」を案内ページから削除します。元に戻せません。よろしいですか？` : ""}
        confirmLabel="削除する"
        cancelLabel="キャンセル"
        danger
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
        testId="onboarding-admin-delete-confirm"
      />
    </div>
  );
}

/** ミーティングの行 (全体 + 名簿の各チーム)。teamId null が全体。 */
interface MeetingTarget {
  teamId: string | null;
  label: string;
  color: string | null;
}

/** 全体 / チームのミーティング案内。カレンダー招待は送らず、日時とリンクを案内ページに出す。 */
function MeetingsCard({ guide, canEdit }: { guide: OnboardingGuide; canEdit: boolean }): JSX.Element {
  const saveMut = useSaveOnboardingMeeting();
  const [editing, setEditing] = useState<MeetingTarget | null>(null);
  const targets: MeetingTarget[] = [
    { teamId: null, label: "全体ミーティング", color: null },
    ...guide.teams.map((t) => ({ teamId: t.id, label: `${t.name}のミーティング`, color: t.color })),
  ];
  const byTeam = new Map(guide.meetings.map((m) => [m.teamId ?? "", m]));
  const current = editing ? (byTeam.get(editing.teamId ?? "") ?? null) : null;

  return (
    <Card header={<span>ミーティング</span>} testId="onboarding-admin-meetings">
      <p className={styles.sectionHint}>
        カレンダーの招待は送りません。ここに入れた日時と参加リンクが、案内ページの最後に「何時にどのリンクへ入るか」として表示されます。チームのミーティングは、案内ページで選ばれたチームの分だけ表示されます。
      </p>
      <ul className={styles.meetingList}>
        {targets.map((t) => {
          const m = byTeam.get(t.teamId ?? "");
          const key = t.teamId ?? "all";
          return (
            <li key={key} className={styles.meetingRow} data-testid={`onboarding-meeting-${key}`}>
              <span className={styles.teamDot} style={t.color ? { background: t.color } : undefined} aria-hidden />
              <div className={styles.onboardingBody}>
                <div className={styles.onboardingTitle}>{t.label}</div>
                {m ? (
                  <>
                    <div className={styles.meetingWhen}>{m.schedule}</div>
                    {m.url ? (
                      <a className={styles.onboardingLink} href={m.url} target="_blank" rel="noreferrer noopener">
                        {m.url}
                      </a>
                    ) : (
                      <span className={styles.meetingUnset}>参加リンク未設定</span>
                    )}
                  </>
                ) : (
                  <span className={styles.meetingUnset}>未設定（案内ページには「追って連絡します」と表示）</span>
                )}
              </div>
              {canEdit ? (
                <div className={styles.onboardingActions}>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(t)} testId={`onboarding-meeting-edit-${key}`}>
                    {m ? "編集" : "設定"}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {editing ? (
        <MeetingDialog
          target={editing}
          meeting={current}
          onCancel={() => setEditing(null)}
          onSave={(input) => {
            saveMut.mutate(input);
            setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function MeetingDialog({
  target,
  meeting,
  onCancel,
  onSave,
}: {
  target: MeetingTarget;
  meeting: OnboardingMeeting | null;
  onCancel: () => void;
  onSave: (input: SaveOnboardingMeetingRequest) => void;
}): JSX.Element {
  const [schedule, setSchedule] = useState(meeting?.schedule ?? "");
  const [url, setUrl] = useState(meeting?.url ?? "");
  const [errors, setErrors] = useState<string[]>([]);

  const submit = (): void => {
    const parsed = parseOnboardingMeetingInput({ teamId: target.teamId, schedule, url });
    // 保存は日時必須 (空にして消すのは「案内を消す」ボタン)。
    const errs = parsed.value.schedule === null ? [...new Set([...parsed.errors, "schedule"])] : parsed.errors;
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    onSave({ teamId: target.teamId, schedule: parsed.value.schedule, url: parsed.value.url });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={target.label}
      testId="onboarding-meeting-dialog"
      footer={
        <div className={styles.dialogActions}>
          {meeting ? (
            <Button
              variant="secondary"
              onClick={() => onSave({ teamId: target.teamId, schedule: null, url: null })}
              testId="onboarding-meeting-clear"
            >
              案内を消す
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onCancel} testId="onboarding-meeting-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} testId="onboarding-meeting-save">
            保存
          </Button>
        </div>
      }
    >
      <form
        className={styles.formStack}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormField
          label="日時"
          htmlFor="onboarding-meeting-schedule"
          required
          help={`例: 10/20(火) 19:00〜 / 毎週水曜 20:00〜（${ONBOARDING_SCHEDULE_MAX} 文字まで）`}
          {...(errors.includes("schedule") ? { error: "日時を入力してください" } : {})}
        >
          <TextField
            id="onboarding-meeting-schedule"
            value={schedule}
            onChange={setSchedule}
            invalid={errors.includes("schedule")}
            testId="onboarding-meeting-schedule"
          />
        </FormField>
        <FormField
          label="参加リンク"
          htmlFor="onboarding-meeting-url"
          help="Google Meet などのリンク（任意）"
          {...(errors.includes("url") ? { error: "http:// または https:// で始まる URL を入力してください" } : {})}
        >
          <TextField
            id="onboarding-meeting-url"
            type="url"
            value={url}
            onChange={setUrl}
            placeholder="https://"
            invalid={errors.includes("url")}
            testId="onboarding-meeting-url"
          />
        </FormField>
      </form>
    </Modal>
  );
}

/** 追加 / 編集ダイアログ。検証は FE/BE 共通の parseOnboardingItemInput。 */
function ItemDialog({
  item,
  onCancel,
  onSave,
}: {
  item: OnboardingItem | null;
  onCancel: () => void;
  onSave: (input: OnboardingItemInput) => void;
}): JSX.Element {
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [errors, setErrors] = useState<string[]>([]);

  const submit = (): void => {
    const parsed = parseOnboardingItemInput({ title, description, url });
    if (parsed.errors.length > 0) {
      setErrors(parsed.errors);
      return;
    }
    const v = parsed.value;
    onSave({ title: v.title as string, description: v.description ?? null, url: v.url ?? null });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={item ? "項目を編集" : "項目を追加"}
      testId="onboarding-item-dialog"
      footer={
        <div className={styles.dialogActions}>
          <Button variant="secondary" onClick={onCancel} testId="onboarding-item-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} testId="onboarding-item-save">
            {item ? "保存" : "追加"}
          </Button>
        </div>
      }
    >
      <form
        className={styles.formStack}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormField
          label="やってほしいこと"
          htmlFor="onboarding-title"
          required
          help={`例: Discord サーバーに参加する（${ONBOARDING_TITLE_MAX} 文字まで）`}
          {...(errors.includes("title") ? { error: "やってほしいことを入力してください" } : {})}
        >
          <TextField id="onboarding-title" value={title} onChange={setTitle} invalid={errors.includes("title")} testId="onboarding-item-title" />
        </FormField>
        <FormField
          label="説明"
          htmlFor="onboarding-description"
          help={`手順や補足があれば書いてください（${ONBOARDING_DESCRIPTION_MAX} 文字まで）`}
          {...(errors.includes("description") ? { error: `${ONBOARDING_DESCRIPTION_MAX} 文字以内で入力してください` } : {})}
        >
          <Textarea
            id="onboarding-description"
            value={description}
            onChange={setDescription}
            rows={4}
            invalid={errors.includes("description")}
            testId="onboarding-item-description"
          />
        </FormField>
        <FormField
          label="リンク"
          htmlFor="onboarding-url"
          help="参加する場所や入力フォームの URL（任意）"
          {...(errors.includes("url") ? { error: "http:// または https:// で始まる URL を入力してください" } : {})}
        >
          <TextField
            id="onboarding-url"
            type="url"
            value={url}
            onChange={setUrl}
            placeholder="https://"
            invalid={errors.includes("url")}
            testId="onboarding-item-url"
          />
        </FormField>
      </form>
    </Modal>
  );
}
