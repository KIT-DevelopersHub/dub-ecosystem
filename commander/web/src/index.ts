// Public surface of @dub/commander-web — the reusable Commander UI, consumed both
// standalone (main.tsx) and as a Dub app (apps/fe2-app-shell/src/features/commander).
// SoT: the run console, phase board and their HTTP clients live here; the shell
// feature only composes them into shell chrome (no logic duplication).
export { App } from "./App.tsx";
export { CommanderConsole } from "./CommanderConsole.tsx";
export type { CommanderConsoleProps } from "./CommanderConsole.tsx";
export { FeatureBoard } from "./FeatureBoard.tsx";

export {
  HttpCommanderClient,
  formatEvent,
  type CommanderClient,
  type DaemonRunEvent,
} from "./lib/client.ts";
export {
  HttpCommanderApi,
  PHASE_LABELS,
  type CommanderApi,
  type Feature,
  type FeatureDetail,
  type FeaturePhase,
  type PhaseTransition,
  type TransitionSpec,
  type ApiError,
  type Result,
} from "./lib/commanderApi.ts";
