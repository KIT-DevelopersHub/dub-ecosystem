// useAudiences — 通知管理「誰に届くか」: per receive audience, the roles holding its key in
// ロール管理 and how many members it reaches. Read-only; failures leave the list usable.

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";
import type { AudienceSummary } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";

export interface UseAudiencesResult {
  items: AudienceSummary[];
  loading: boolean;
  error: ApiError | null;
  reload(): Promise<void>;
}

export function useAudiences(): UseAudiencesResult {
  const { api } = useNotificationDeps();
  const [items, setItems] = useState<AudienceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await api.listAudiences()).items);
    } catch (err) {
      if (isApiError(err)) setError(err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, loading, error, reload };
}
