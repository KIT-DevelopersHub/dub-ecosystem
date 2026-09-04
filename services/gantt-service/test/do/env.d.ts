// Bridges the miniflare-provided `cloudflare:test` env to the worker's Env so
// env.GANTT_ROOM is typed as the GanttRoom DO namespace in tests.
import type { Env } from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
