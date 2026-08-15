// Lazy, accessible file/folder tree for the Drive sharing manager.
//
// Each folder is a disclosure row: the ▶/▼ toggle expands it and its DIRECT children
// are fetched on demand (listFiles({folderId}), cached by react-query under
// childrenQueryKey) — the whole hierarchy is never loaded up front. Opening is
// optimistic (the row flips immediately; a skeleton fills the level until the fetch
// resolves). Toggling (▶) and selecting (row body) are deliberately separate actions
// so a folder can be browsed without stealing the detail panel selection.
//
// a11y: role=tree/treeitem/group with aria-expanded / aria-level / aria-selected, one
// roving tab stop, and full keyboard control (↑↓ move · → expand/into · ← collapse/out
// · Enter/Space select). All spacing/colour comes from @dub/tokens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Icon, SkeletonLoader } from "@dub/ui";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useDriveShareApi } from "./DriveShareProvider.tsx";
import { ariaLevel, childrenQueryKey, nextFocusIndex, toggleExpanded } from "./tree.ts";
import styles from "./driveshare.module.css";
import {
  driveRoleTone,
  roleGrantChipLabel,
  type DriveFile,
  type RoleFileGrant,
} from "./driveShareApi.tsx";

/** Look up a file's role grants (indexed once by the screen). */
export type GrantsFor = (fileId: string) => readonly RoleFileGrant[];

function formatUpdated(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

/** Color chips summarising a node's role grants (e.g. 「開発: 編集」). Text carries the
 *  meaning; the tone is decorative only (keeps it accessible). */
function NodeChips({ grants }: { grants: readonly RoleFileGrant[] }): JSX.Element | null {
  if (grants.length === 0) return null;
  return (
    <span data-testid="fe2-driveshare-file-chips" className={styles.chips}>
      {grants.map((g) => (
        <Badge key={g.id} tone={driveRoleTone(g.driveRole)} testId="fe2-driveshare-file-chip">
          {roleGrantChipLabel(g)}
        </Badge>
      ))}
    </span>
  );
}

interface TreeContext {
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (file: DriveFile) => void;
  grantsFor: GrantsFor;
  focusedId: string | null;
  /** Registry so keyboard Enter/Space (which only knows the focused id) can resolve
   *  the DriveFile to select. Each rendered node registers itself. */
  register: (file: DriveFile) => void;
}

/** One row: [toggle?] [icon] name [link badge] [chips] · owner / updated. The <li> is
 *  the focusable treeitem; the inner buttons are clickable by mouse but out of the tab
 *  order (single roving tab stop lives on the treeitem). */
function TreeNode({ file, depth, ctx }: { file: DriveFile; depth: number; ctx: TreeContext }): JSX.Element {
  const isFolder = file.isFolder;
  const isOpen = isFolder && ctx.expanded.has(file.id);
  const active = ctx.selectedId === file.id;
  const grants = ctx.grantsFor(file.id);

  useEffect(() => {
    ctx.register(file);
  });

  return (
    <li
      role="treeitem"
      className={styles.treeitem}
      aria-level={ariaLevel(depth)}
      aria-selected={active}
      {...(isFolder ? { "aria-expanded": isOpen } : {})}
      data-node-id={file.id}
      data-folder={isFolder ? "true" : "false"}
      tabIndex={ctx.focusedId === file.id ? 0 : -1}
    >
      <div className={styles.row} data-active={active ? "true" : "false"} data-folder={isFolder ? "true" : "false"}>
        {isFolder ? (
          <button
            type="button"
            data-testid="fe2-driveshare-toggle"
            className={styles.toggle}
            tabIndex={-1}
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onToggle(file.id);
            }}
          >
            <Icon name={isOpen ? "chevron-down" : "chevron-right"} />
          </button>
        ) : (
          // keep files aligned with their sibling folders (no toggle glyph).
          <span aria-hidden="true" className={styles.togglePlaceholder} />
        )}

        <button
          type="button"
          data-testid="fe2-driveshare-file"
          className={styles.rowMain}
          tabIndex={-1}
          aria-pressed={active}
          aria-label={`${file.name}${isFolder ? "（フォルダ）" : ""}`}
          onClick={() => ctx.onSelect(file)}
        >
          <span className={styles.rowTitle}>
            <span className={isFolder ? styles.folderIcon : styles.fileIcon} aria-hidden="true">
              <Icon name={isFolder ? (isOpen ? "folder-open" : "folder") : "file"} />
            </span>
            <strong className={styles.name}>{file.name}</strong>
            {file.linkShared ? (
              <Badge tone="info" testId="fe2-driveshare-linkbadge">
                リンク共有中
              </Badge>
            ) : null}
            <NodeChips grants={grants} />
          </span>
          <small className={styles.rowMeta}>
            {file.ownerName ? `オーナー: ${file.ownerName}` : ""}
            {file.modifiedTime ? ` ・ 更新 ${formatUpdated(file.modifiedTime)}` : ""}
          </small>
        </button>
      </div>

      {isOpen ? <ChildGroup folderId={file.id} depth={depth + 1} ctx={ctx} /> : null}
    </li>
  );
}

/** The lazily-fetched children of one open folder. Skeleton while loading, a retry on
 *  error, a subtle "（空のフォルダ）" note when empty, else the nested treeitems. */
function ChildGroup({ folderId, depth, ctx }: { folderId: string; depth: number; ctx: TreeContext }): JSX.Element {
  const driveApi = useDriveShareApi();
  const query = useQuery({
    queryKey: childrenQueryKey(folderId),
    queryFn: () => driveApi.listFiles({ folderId, limit: 200 }),
  });

  if (query.isPending) {
    return (
      <div data-testid="fe2-driveshare-tree-loading" className={styles.childState}>
        <SkeletonLoader lines={2} />
      </div>
    );
  }
  if (query.isError) {
    const display = ApiError.isApiError(query.error)
      ? toDisplayableError(query.error)
      : { code: "INTERNAL", message: "フォルダを読み込めませんでした。" };
    return (
      <div className={styles.childState}>
        <small className={styles.errorText}>
          {display.message}{" "}
          <button
            type="button"
            data-testid="fe2-driveshare-tree-retry"
            className={styles.retryLink}
            tabIndex={-1}
            onClick={() => void query.refetch()}
          >
            再読み込み
          </button>
        </small>
      </div>
    );
  }
  const children = query.data.files;
  if (children.length === 0) {
    return (
      <div className={styles.childState}>
        <small className={styles.mutedText}>（空のフォルダ）</small>
      </div>
    );
  }
  return (
    <ul role="group" className={styles.group}>
      {children.map((f) => (
        <TreeNode key={f.id} file={f} depth={depth} ctx={ctx} />
      ))}
    </ul>
  );
}

export function DriveTree({
  files,
  selectedId,
  onSelect,
  grantsFor,
}: {
  files: readonly DriveFile[];
  selectedId: string | null;
  onSelect: (file: DriveFile) => void;
  grantsFor: GrantsFor;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  // id → DriveFile, rebuilt every render as nodes register, so keyboard select (which
  // only carries the focused id) can resolve the file to hand to onSelect.
  const nodeMap = useRef(new Map<string, DriveFile>());
  nodeMap.current = new Map();

  // Seed the roving tab stop on the first root node once files arrive.
  useEffect(() => {
    if (focusedId === null && files.length > 0) setFocusedId(files[0]!.id);
  }, [files, focusedId]);

  const ctx: TreeContext = useMemo(
    () => ({
      expanded,
      onToggle: (id) => setExpanded((prev) => toggleExpanded(prev, id)),
      selectedId,
      onSelect,
      grantsFor,
      focusedId,
      register: (file) => nodeMap.current.set(file.id, file),
    }),
    [expanded, selectedId, onSelect, grantsFor, focusedId],
  );

  const visibleItems = (): HTMLElement[] =>
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);

  const focusAt = (items: HTMLElement[], index: number): void => {
    const el = items[index];
    if (!el) return;
    const id = el.dataset.nodeId ?? null;
    setFocusedId(id);
    el.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!target) return;
    const items = visibleItems();
    const idx = items.indexOf(target);
    if (idx === -1) return;
    const id = target.dataset.nodeId!;
    const isFolder = target.dataset.folder === "true";
    const isOpen = target.getAttribute("aria-expanded") === "true";

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(items, nextFocusIndex(idx, items.length, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(items, nextFocusIndex(idx, items.length, -1));
        break;
      case "ArrowRight":
        if (isFolder && !isOpen) {
          e.preventDefault();
          ctx.onToggle(id);
        } else if (isFolder && isOpen) {
          e.preventDefault();
          focusAt(items, nextFocusIndex(idx, items.length, 1));
        }
        break;
      case "ArrowLeft":
        if (isFolder && isOpen) {
          e.preventDefault();
          ctx.onToggle(id);
        } else {
          // move focus to the enclosing folder (li → group ul → parent li).
          const parent = target.parentElement?.closest<HTMLElement>('[role="treeitem"]');
          if (parent) {
            e.preventDefault();
            focusAt(items, items.indexOf(parent));
          }
        }
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const file = nodeMap.current.get(id);
        if (file) onSelect(file);
        break;
      }
      default:
        break;
    }
  };

  return (
    <ul
      ref={treeRef}
      role="tree"
      className={styles.tree}
      aria-label="共有ドライブのファイルとフォルダ"
      data-testid="fe2-driveshare-tree"
      onKeyDown={handleKeyDown}
    >
      {files.map((f) => (
        <TreeNode key={f.id} file={f} depth={0} ctx={ctx} />
      ))}
    </ul>
  );
}
