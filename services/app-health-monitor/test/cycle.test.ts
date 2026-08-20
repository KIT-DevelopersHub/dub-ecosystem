import { describe, it, expect, vi } from "vitest";
import { runCheckCycle } from "../src/monitor";
import { createMemoryRepo } from "../src/repo";
import type { Notifier } from "../src/notify";
import type { Env } from "../src/env";
import type { TargetResult } from "../src/types";

function fakeNotifier() {
  const down = vi.fn(async () => {});
  const recovery = vi.fn(async () => {});
  return { notifier: { down, recovery } as Notifier, down, recovery };
}

const env = {} as Env;
const gatherOf = (results: TargetResult[]) => () => Promise.resolve(results);

const mail = (status: "ok" | "down"): TargetResult => ({
  id: "fe:mail",
  kind: "frontend",
  label: "画面: メール",
  status,
  detail: status === "down" ? "HTTP 404 chunk missing" : "route+chunks ok",
});

describe("runCheckCycle — end-to-end down -> alert -> recovery", () => {
  it("alerts admins after 2 consecutive downs, once, then clears on recovery", async () => {
    const repo = createMemoryRepo();
    const { notifier, down, recovery } = fakeNotifier();

    // cycle 1: down (fails=1) -> no alert yet
    let s = await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) });
    expect(s.down).toBe(1);
    expect(down).toHaveBeenCalledTimes(0);

    // cycle 2: down again (fails=2) -> ONE down alert
    s = await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) });
    expect(s.firedDown).toBe(1);
    expect(down).toHaveBeenCalledTimes(1);

    // cycle 3: still down -> NO re-alert
    s = await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) });
    expect(down).toHaveBeenCalledTimes(1);

    // cycle 4: recovered -> ONE recovery alert
    s = await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("ok")]) });
    expect(s.firedRecovery).toBe(1);
    expect(recovery).toHaveBeenCalledTimes(1);

    // final persisted status is ok
    const statuses = await repo.listStatuses();
    expect(statuses.find((r) => r.targetId === "fe:mail")?.status).toBe("ok");
  });

  it("records an incident row on down and on recovery", async () => {
    const repo = createMemoryRepo();
    const { notifier } = fakeNotifier();
    const addIncident = vi.spyOn(repo, "addIncident");

    await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) });
    await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) }); // down incident
    await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("ok")]) }); // recovery incident
    expect(addIncident).toHaveBeenCalledTimes(2);
  });

  it("a single transient blip never pages", async () => {
    const repo = createMemoryRepo();
    const { notifier, down } = fakeNotifier();
    await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("down")]) }); // fails=1
    await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("ok")]) }); // recovered before threshold
    expect(down).not.toHaveBeenCalled();
  });

  it("counts extraTargets (synthetic) in the cycle", async () => {
    const repo = createMemoryRepo();
    const { notifier } = fakeNotifier();
    const synthetic: TargetResult = { id: "synthetic:probe", kind: "service", label: "(合成テスト)", status: "down", detail: "forced" };
    const s = await runCheckCycle(env, repo, notifier, { gather: gatherOf([mail("ok")]), extraTargets: [synthetic] });
    expect(s.checked).toBe(2);
    expect(s.down).toBe(1);
  });
});
