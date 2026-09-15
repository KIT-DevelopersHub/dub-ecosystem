// The feature phase state machine now lives in the shared `@dub/commander-phases`
// package so the local daemon and the commander-service worker share ONE source of
// truth for the transition table (二重定義禁止). This file re-exports it unchanged so
// existing daemon imports (`./phases.ts`) keep working.
export * from "@dub/commander-phases";
