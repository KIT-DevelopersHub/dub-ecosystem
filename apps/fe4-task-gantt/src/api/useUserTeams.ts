// 人 → 所属チーム (担当から task の teamId を決めるため)。1 クライアント・1 利用者につき 1 回だけ
// 取得して共有する。Provider 外・取得失敗は空 (= チームは変えない)。
import { useEffect, useState } from "react";
import type { common } from "@dub/types";
import type { ApiClient } from "../contracts/spa-shell";
import type { UserTeamsLookup } from "../domain/assignee";
import { useTaskRoute } from "../routes/task-route-context";
import { useOptionalApiClient } from "./client-context";
import { listUserTeams } from "./endpoints";

const EMPTY: UserTeamsLookup = new Map();
const cache = new WeakMap<ApiClient, Map<string, Promise<UserTeamsLookup>>>();

function load(client: ApiClient, me: common.UserId | null): Promise<UserTeamsLookup> {
  let byUser = cache.get(client);
  if (!byUser) cache.set(client, (byUser = new Map()));
  const key = me ?? "";
  let p = byUser.get(key);
  if (!p) {
    p = listUserTeams(client, me).catch(() => EMPTY);
    byUser.set(key, p);
  }
  return p;
}

export function useUserTeams(): UserTeamsLookup {
  const client = useOptionalApiClient();
  const { currentUserId } = useTaskRoute();
  const [lookup, setLookup] = useState<UserTeamsLookup>(EMPTY);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void load(client, currentUserId).then((m) => {
      if (live) setLookup(m);
    });
    return () => {
      live = false;
    };
  }, [client, currentUserId]);
  return lookup;
}
