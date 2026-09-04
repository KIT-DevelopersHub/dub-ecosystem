// Two projects: node-environment tests (HTTP read model, ws-ticket HMAC, realtime
// publisher wiring) and Workers-runtime tests (GanttRoom DO: WS / fanout / ticket verify).
// `vitest run` (the package `test` script) runs both.
export default ["./vitest.config.ts", "./vitest.workers.config.ts"];
