// Sender block list mutations (この送信者をブロック / ブロックを解除), optimistic per
// FRONTEND_GUIDE §5.3: the store's block list changes first (threads re-file instantly via
// the derived `blocked` flag), the gateway call follows, a success reconciles with the
// server's row and a failure restores the snapshot + shows an error notice.
import { useCallback } from "react";
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import { useMailStore } from "./useMailStore.tsx";
import type { BlockKind } from "./mailModel.ts";

export interface SenderBlocks {
  block(value: string, kind: BlockKind): void;
  /** Block several addresses at once (a selection). Those that fail are rolled back alone. */
  blockMany(emails: string[]): void;
  unblock(value: string): void;
}

const blockLabel = (b: Pick<mail.MailSenderBlock, "value" | "kind">): string =>
  b.kind === "domain" ? `ドメイン「${b.value}」` : b.value;

export function useSenderBlocks(): SenderBlocks {
  const api = useMailApi();
  const { state, dispatch } = useMailStore();
  const current = state.blocks;

  const block = useCallback(
    (raw: string, kind: BlockKind): void => {
      const email = raw.trim().toLowerCase();
      const value = kind === "domain" ? email.slice(email.lastIndexOf("@") + 1) : email;
      if (!value || current.some((b) => b.value === value)) return;
      const snapshot = current;
      const optimistic: mail.MailSenderBlock = { value, kind, createdAt: new Date().toISOString() };
      dispatch({ type: "SET_BLOCKS", blocks: [optimistic, ...snapshot] });
      dispatch({ type: "BLOCK_NOTICE", notice: { status: "blocked", text: `${blockLabel(optimistic)} をブロックしました`, block: optimistic } });
      api
        .addBlock({ value, kind })
        .then((saved) => dispatch({ type: "SET_BLOCKS", blocks: [saved, ...snapshot.filter((b) => b.value !== saved.value)] }))
        .catch(() => {
          dispatch({ type: "SET_BLOCKS", blocks: snapshot });
          dispatch({ type: "BLOCK_NOTICE", notice: { status: "failed", text: `${blockLabel(optimistic)} をブロックできませんでした` } });
        });
    },
    [api, current, dispatch],
  );

  const blockMany = useCallback(
    (emails: string[]): void => {
      const snapshot = current;
      const values = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((v) => v && !snapshot.some((b) => b.value === v));
      if (values.length === 0) return;
      const now = new Date().toISOString();
      const optimistic = values.map((value): mail.MailSenderBlock => ({ value, kind: "address", createdAt: now }));
      dispatch({ type: "SET_BLOCKS", blocks: [...optimistic, ...snapshot] });
      void Promise.allSettled(values.map((value) => api.addBlock({ value, kind: "address" }))).then((results) => {
        const saved = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        dispatch({ type: "SET_BLOCKS", blocks: [...saved, ...snapshot] });
        const failed = values.length - saved.length;
        dispatch({
          type: "BLOCK_NOTICE",
          notice:
            failed > 0
              ? { status: "failed", text: `${values.length}件中${failed}件の送信者をブロックできませんでした` }
              : { status: "blocked", text: `${values.length}件の送信者をブロックしました` },
        });
      });
    },
    [api, current, dispatch],
  );

  const unblock = useCallback(
    (value: string): void => {
      const target = current.find((b) => b.value === value);
      if (!target) return;
      const snapshot = current;
      dispatch({ type: "SET_BLOCKS", blocks: snapshot.filter((b) => b.value !== value) });
      dispatch({ type: "BLOCK_NOTICE", notice: { status: "unblocked", text: `${blockLabel(target)} のブロックを解除しました`, block: target } });
      api.removeBlock(value).catch(() => {
        dispatch({ type: "SET_BLOCKS", blocks: snapshot });
        dispatch({ type: "BLOCK_NOTICE", notice: { status: "failed", text: `${blockLabel(target)} のブロックを解除できませんでした` } });
      });
    },
    [api, current, dispatch],
  );

  return { block, blockMany, unblock };
}
