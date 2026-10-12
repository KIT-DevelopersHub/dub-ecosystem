// Relay agent entrypoint. Local-only; run next to the daemon + commander-service:
//   node --experimental-strip-types commander/daemon/src/relay.ts
//
// Env:
//   COMMANDER_RELAY_URL       wss://dub-commander-relay.<sub>.workers.dev/ws/agent (required)
//   COMMANDER_RELAY_SECRET    the relay's RELAY_AGENT_SECRET (required)
//   COMMANDER_DAEMON_URL      default http://127.0.0.1:4319
//   COMMANDER_SERVICE_URL     default http://127.0.0.1:8798
//   COMMANDER_OPERATOR_TOKEN  the loopback operator token (dev-up.sh's .commander.env.local)
//   COMMANDER_RELAY_CWD_ROOTS comma-separated dirs a relayed run may use as cwd
//                             (default: the parent of the current directory, i.e. the worktrees)
import { dirname } from "node:path";
import { RelayAgent, type AgentSocket } from "./relay-agent.ts";

const relayUrl = process.env.COMMANDER_RELAY_URL ?? "";
const relaySecret = process.env.COMMANDER_RELAY_SECRET ?? "";
if (!relayUrl || !relaySecret) {
  console.error("[relay-agent] COMMANDER_RELAY_URL and COMMANDER_RELAY_SECRET are required");
  process.exit(1);
}
if (!/^wss:\/\//.test(relayUrl) && !/^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(relayUrl)) {
  // The bearer secret rides the upgrade request; never send it in clear text off-machine.
  console.error("[relay-agent] COMMANDER_RELAY_URL must be wss:// (ws:// only for loopback dev)");
  process.exit(1);
}

const agent = new RelayAgent(
  {
    relayUrl,
    relaySecret,
    daemonUrl: process.env.COMMANDER_DAEMON_URL ?? "http://127.0.0.1:4319",
    serviceUrl: process.env.COMMANDER_SERVICE_URL ?? "http://127.0.0.1:8798",
    operatorToken: process.env.COMMANDER_OPERATOR_TOKEN ?? "",
    cwdRoots: (process.env.COMMANDER_RELAY_CWD_ROOTS ?? dirname(process.cwd()))
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("/")),
  },
  {
    // Node's WebSocket (undici) accepts a headers option on top of the browser API.
    openSocket: (url, secret) =>
      new (WebSocket as unknown as new (u: string, o: unknown) => AgentSocket)(url, {
        headers: { authorization: `Bearer ${secret}` },
      }),
    fetch: globalThis.fetch.bind(globalThis),
    log: (m) => console.log(m),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
);

agent.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    agent.stop();
    process.exit(0);
  });
}
