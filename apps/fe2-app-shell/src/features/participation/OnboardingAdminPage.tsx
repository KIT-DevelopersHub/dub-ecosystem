// オンボーディング (運営メンバー・名簿 → オンボーディング タブ)。新しく入った人に最初に
// やってほしいことを並べ、ログイン不要の公開ページ (/onboarding) で共有する。項目の追加・
// 編集・削除・ドラッグ並び替えは 参加届アプリの「編集」、閲覧だけなら一覧と共有 URL のみ。
// 編集系は楽観的 UI (hooks.ts の useOnboardingMutation が失敗時にロールバック)。
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
  useUpdateOnboardingItem,
} from "./hooks.ts";
import {
  ONBOARDING_DESCRIPTION_MAX,
  ONBOARDING_TITLE_MAX,
  parseOnboardingItemInput,
  type OnboardingItem,
  type OnboardingItemInput,
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
        disabled={!canEdit || hasPending || reorderMut.isPending}
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
