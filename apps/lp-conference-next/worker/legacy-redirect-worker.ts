// Retired-version Worker: its build can no longer be reproduced, so every request is
// sent (301) to the current public LP instead of serving stale copy.
// NOTE: only `export default` here — workerd treats named exports as entrypoints.
import { legacyRedirect } from "./legacy-redirect.ts";

export default { fetch: legacyRedirect };
