// Two projects: node-environment tests (HTTP master, in-memory repo, ws-ticket
// HMAC) and Workers-runtime tests (ChatRoom DO: WS / fanout / ticket verify).
// `vitest run` (the package `test` script) runs both.
export default ["./vitest.config.ts", "./vitest.workers.config.ts"];
