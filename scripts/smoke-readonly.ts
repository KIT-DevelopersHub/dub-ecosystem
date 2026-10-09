// Read-only contract smoke for a deployed environment: GET only, no credentials, never
// writes. Each check = status code + response JSON validated against the schema in
// docs/openapi/api-gateway.yaml (logic: packages/e2e-smoke/src/live-contract.ts).
//
//   node scripts/smoke-readonly.ts <staging|prod> [--base-url <origin>]
//
// Runs on Node >= 22.18 / 24 native type stripping (no tsx). Exit 0 = all pass, 1 = a
// contract violation, 2 = usage error.
import { GATEWAY_ORIGINS, runLiveChecks, type LiveEnv } from "../packages/e2e-smoke/src/live-contract.ts";

const [env, flag, override] = process.argv.slice(2);
if (env !== "staging" && env !== "prod") {
  console.error("usage: node scripts/smoke-readonly.ts <staging|prod> [--base-url <origin>]");
  process.exit(2);
}
const baseUrl = flag === "--base-url" && override ? override : GATEWAY_ORIGINS[env as LiveEnv];

console.log(`read-only smoke: ${env} -> ${baseUrl}`);
const results = await runLiveChecks(baseUrl);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  GET ${r.check.path} -> ${r.check.status}`);
  for (const p of r.problems) console.log(`      ${p}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `all ${results.length} checks passed` : `${failed}/${results.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
