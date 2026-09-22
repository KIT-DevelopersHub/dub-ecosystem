// @dub/fe3-event-action block editor — the widget-canvas editor generalised from
// the しおり panel, reused by the event-page inline editor (and available to any
// future surface that wants a free block layout).
export { BlockEditor, BLOCK_EDITOR_MARKER, type BlockEditorProps } from "./BlockEditor";
export { hasDoc, loadDoc, saveDoc, sampleEventDoc, emptyDoc } from "./storage";
export type { Block, BlockDoc, BlockType, ColSpan } from "./types";
