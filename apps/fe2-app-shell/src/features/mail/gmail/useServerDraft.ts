// Autosaves a compose to the server (Gmail 下書き) so it survives closing the window and shows
// in the 下書き folder. Text is debounced; each file is uploaded once and removed individually.
// Everything runs through one promise chain so a save and an upload for the same id can't
// overtake each other (the attachment route needs the draft row to exist first).
import { useCallback, useEffect, useRef, useState } from "react";
import type { mail } from "@dub/types";
import { useMailApi } from "../MailProvider.tsx";
import type { UseComposeAttachments } from "../useComposeAttachments.tsx";
import { useMailStore } from "./useMailStore.tsx";

export const DRAFT_AUTOSAVE_MS = 1500;

export type DraftStatus = "idle" | "saving" | "saved" | "failed";

export interface ServerDraft {
  status: DraftStatus;
  /** Save whatever is unsaved now. Resolves true when the server has all of it. */
  flush: () => Promise<boolean>;
  /** Forget the draft on the server (discarded). */
  discard: () => void;
  /** Stop saving: the mail was handed to the send path, which removes the draft. */
  stop: () => void;
  /** Does a row for this draft exist on the server right now? */
  isSaved: () => boolean;
}

export function useServerDraft({
  id,
  draft,
  active,
  persisted = false,
  att,
}: {
  id: string;
  draft: mail.MailDraftInput;
  /** Is there something worth keeping? Turning false removes a saved draft. */
  active: boolean;
  /** The draft already exists on the server, exactly as `draft` is now. */
  persisted?: boolean;
  att: UseComposeAttachments;
}): ServerDraft {
  const api = useMailApi();
  const { dispatch } = useMailStore();
  const [status, setStatus] = useState<DraftStatus>("idle");
  const key = JSON.stringify(draft);
  const onServer = useRef(persisted);
  const savedKey = useRef(persisted ? key : "");
  const stopped = useRef(false);
  const uploadFailed = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ draft, key });
  latest.current = { draft, key };
  // Files known to be on the server: local item id -> stored metadata.
  const remote = useRef(new Map<string, mail.MailAttachment>());
  const uploading = useRef(new Set<string>());

  // The inline reply box moves to a fresh id after each send.
  const currentId = useRef(id);
  if (currentId.current !== id) {
    currentId.current = id;
    onServer.current = false;
    savedKey.current = "";
    stopped.current = false;
    uploadFailed.current = false;
    remote.current = new Map();
  }

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const save = useCallback(
    () =>
      enqueue(async () => {
        const { draft: value, key: valueKey } = latest.current;
        if (stopped.current || (onServer.current && valueKey === savedKey.current)) return;
        setStatus("saving");
        try {
          const saved = await api.saveDraft(id, value);
          onServer.current = true;
          savedKey.current = valueKey;
          dispatch({ type: "UPSERT_DRAFT", draft: { ...saved, attachments: [...remote.current.values()] } });
          setStatus("saved");
        } catch (err) {
          setStatus("failed");
          throw err;
        }
      }),
    [api, dispatch, enqueue, id],
  );

  const remove = useCallback(() => {
    onServer.current = false;
    savedKey.current = "";
    remote.current.clear();
    dispatch({ type: "REMOVE_DRAFT", id });
    void enqueue(() => api.deleteDraft(id)).catch(() => undefined);
    setStatus("idle");
  }, [api, dispatch, enqueue, id]);

  // Debounced text save; emptied again -> the saved draft goes away.
  useEffect(() => {
    if (stopped.current) return;
    if (!active) {
      if (onServer.current) remove();
      return;
    }
    if (onServer.current && key === savedKey.current) return;
    const t = setTimeout(() => void save().catch(() => undefined), DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [active, key, remove, save]);

  // Attachments: upload what is new, delete what was removed from the tray.
  const { items, setRemoteId } = att;
  useEffect(() => {
    if (stopped.current || !active) return;
    const publish = (): void => dispatch({ type: "SET_DRAFT_ATTACHMENTS", id, attachments: [...remote.current.values()] });
    for (const item of items) {
      if (item.remoteId && !remote.current.has(item.id)) {
        remote.current.set(item.id, { id: item.remoteId, filename: item.filename, contentType: item.contentType, sizeBytes: item.sizeBytes });
      }
      const input = item.input;
      if (item.status !== "ready" || !input || item.remoteId || uploading.current.has(item.id)) continue;
      uploading.current.add(item.id);
      void save()
        .then(() =>
          enqueue(async () => {
            if (stopped.current) return;
            const meta = await api.addDraftAttachment(id, input);
            remote.current.set(item.id, meta);
            setRemoteId(item.id, meta.id);
            publish();
          }),
        )
        .catch(() => {
          uploadFailed.current = true;
          setStatus("failed");
        })
        .finally(() => uploading.current.delete(item.id));
    }
    const present = new Set(items.map((i) => i.id));
    for (const [localId, meta] of remote.current) {
      if (present.has(localId)) continue;
      remote.current.delete(localId);
      publish();
      void enqueue(() => api.removeDraftAttachment(id, meta.id)).catch(() => undefined);
    }
  }, [active, api, dispatch, enqueue, id, items, save, setRemoteId]);

  const flush = useCallback(async (): Promise<boolean> => {
    try {
      if (!onServer.current || latest.current.key !== savedKey.current) await save();
      await queue.current;
      return !uploadFailed.current;
    } catch {
      return false;
    }
  }, [save]);

  const discard = useCallback(() => {
    stopped.current = true;
    remove();
  }, [remove]);

  const stop = useCallback(() => {
    stopped.current = true;
  }, []);

  const isSaved = useCallback(() => onServer.current, []);

  return { status, flush, discard, stop, isSaved };
}
