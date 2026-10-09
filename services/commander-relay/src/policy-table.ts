// THE authorization surface of commander-relay's HTTP API (reached only through api-gateway,
// segment "commander", which forwards x-dub-user-id). `policyGate` (mounted first in app.ts)
// enforces it. The two WebSocket endpoints are NOT HTTP routes of this app: the Worker entry
// routes them straight to the CommanderRelay DO, which verifies the browser's ticket (minted
// by the edit-gated route below) or, for the local agent, the entry checks the agent secret.
import { appLevel, definePolicyTable, PUBLIC } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  "GET /health": PUBLIC,
  // Opening the relay socket lets the holder run prompts on the operator's PC, i.e. it is
  // the "edit" level of the Commander app, not "view".
  "POST /commander/relay/ticket": appLevel("commander", "edit"),
  // Only says whether the local agent is connected; no task data.
  "GET /commander/relay/status": appLevel("commander", "view"),
});
