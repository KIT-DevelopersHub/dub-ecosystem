// The daemon starts as `node --experimental-strip-types src/index.ts`, which rejects TS-only
// syntax (parameter properties, enums, namespaces) that vitest happily transpiles. Load the
// server module graph under the real runtime so such syntax fails here, not at launch.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("loads the daemon modules under node --experimental-strip-types", () => {
  const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(server)}); console.log("ok")`],
    { encoding: "utf8" },
  );
  expect(out.trim()).toBe("ok");
});
