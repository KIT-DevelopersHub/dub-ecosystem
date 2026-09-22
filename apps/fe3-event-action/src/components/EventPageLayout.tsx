// EventPageLayout — the D1-backed wrapper around the generic BlockEditor for the
// event hub page's "イベント編集" free block layout. It replaces the block editor's
// old localStorage-only persistence with the real event-service store:
//   - GET /events/:id/page-layout on open (shared, cross-viewer, version-locked)
//   - PUT /events/:id/page-layout on edit (debounced autosave; optimistic — the
//     canvas updates instantly, the save flushes in the background)
// localStorage stays as an offline/first-touch fallback (BlockEditor still writes it),
// but D1 is the source of truth so a reload / another member sees the same layout.
//
// Save strategy: coalesce rapid edits behind a single in-flight PUT + a debounce, and
// track the row version in a ref (not react-query cache) so per-keystroke saves never
// churn the query or remount the editor. On a version conflict we refetch the latest
// version and retry the local doc once (last-write-wins; a single organiser editing at
// a time is the norm).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SkeletonLoader } from "@dub/ui";
import type { common } from "@dub/types";
import { BlockEditor } from "../blockeditor";
import { loadDoc, emptyDoc } from "../blockeditor/storage";
import type { BlockDoc } from "../blockeditor/types";
import { useEventApi } from "../context/ApiContext";
import { useEventPageLayoutQuery } from "../hooks/useEventQueries";
import { emptyEventPageLayout, type EventPageLayout as EventPageLayoutDto } from "../api/pageLayoutContracts";
import { isVersionConflict, normalizeError } from "../lib/errorMap";
import styles from "./components.module.css";

const SAVE_DEBOUNCE_MS = 700;

type SaveStatus = "idle" | "saving" | "saved" | "error";

function statusLabel(s: SaveStatus): string {
  switch (s) {
    case "saving":
      return "保存中…";
    case "saved":
      return "保存しました";
    case "error":
      return "保存に失敗しました（自動で再試行します）";
    default:
      return "";
  }
}

function Inner({
  eventId,
  mode,
  canWrite,
  seed,
  server,
}: {
  eventId: common.EventId;
  mode: "edit" | "view";
  canWrite: boolean;
  seed?: BlockDoc;
  server: EventPageLayoutDto;
}) {
  const api = useEventApi();
  const versionRef = useRef(server.version);
  const pending = useRef<BlockDoc | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BlockEditor emits onDocChange once on mount with the initial doc; skip that so
  // merely opening the editor never writes to D1 — only real edits do.
  const firstFire = useRef(true);
  const [status, setStatus] = useState<SaveStatus>("idle");

  const flush = useCallback(async () => {
    if (inFlight.current) return;
    const doc = pending.current;
    if (!doc) return;
    pending.current = null;
    inFlight.current = true;
    setStatus("saving");
    try {
      const res = await api.saveEventPageLayout(eventId, { data: doc, version: versionRef.current });
      versionRef.current = res.version;
      setStatus("saved");
    } catch (e) {
      if (isVersionConflict(normalizeError(e))) {
        try {
          const latest = await api.getEventPageLayout(eventId);
          versionRef.current = latest.version;
          pending.current = doc; // retry this doc against the fresh version
        } catch {
          setStatus("error");
        }
      } else {
        setStatus("error");
      }
    } finally {
      inFlight.current = false;
      if (pending.current) void flush(); // drain edits queued during the request
    }
  }, [api, eventId]);

  const save = useCallback(
    (doc: BlockDoc) => {
      if (firstFire.current) {
        firstFire.current = false;
        return;
      }
      pending.current = doc;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Flush any pending edit on unmount (e.g. 編集を終了) so the last keystroke isn't lost.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void flush();
    };
  }, [flush]);

  // Compute the initial doc ONCE — never re-seed from later query refetches (that would
  // remount the editor mid-edit). Server doc wins when it has content; otherwise, in
  // edit mode fall back to a local draft / seed so first-time editing opens usefully.
  const initial = useMemo<BlockDoc>(() => {
    if (server.data.blocks.length > 0) return server.data;
    if (mode === "edit") return loadDoc(eventId) ?? seed ?? emptyDoc();
    return emptyDoc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {canWrite ? (
        <div className={styles.savedHint} data-testid="fe3-page-layout-status" aria-live="polite">
          {statusLabel(status)}
        </div>
      ) : null}
      <BlockEditor
        storageKey={eventId}
        canWrite={canWrite}
        initialDoc={initial}
        onDocChange={canWrite ? save : undefined}
      />
    </>
  );
}

export function EventPageLayout({
  eventId,
  mode,
  canWrite,
  seed,
}: {
  eventId: common.EventId;
  /** "edit" = the active block-canvas; "view" = the resting read-only layout. */
  mode: "edit" | "view";
  canWrite: boolean;
  /** Starter canvas for a first-time edit when nothing is saved yet (edit mode only). */
  seed?: BlockDoc;
}) {
  const q = useEventPageLayoutQuery(eventId);

  if (q.isPending) {
    // Edit mode: skeleton (the user explicitly opened the editor). View mode: render
    // nothing until settled — avoids a skeleton flash above the details panel for the
    // common "no layout yet" case.
    return mode === "edit" ? <SkeletonLoader lines={6} /> : null;
  }

  const server = q.data ?? emptyEventPageLayout(eventId);

  // Resting view with no shared layout: show nothing (the structured detail panel below
  // is the content). A local draft is intentionally NOT surfaced in the shared view.
  if (mode === "view" && server.data.blocks.length === 0) return null;

  return <Inner key={eventId} eventId={eventId} mode={mode} canWrite={canWrite} seed={seed} server={server} />;
}
