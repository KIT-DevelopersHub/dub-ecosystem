// usePreferences — load defaults+overrides, present the merged matrix, edit
// locally, and PATCH only the diff optimistically (FE5 §2-2, tests 11,12,17).

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";
import type { NotificationChannel, PreferenceEntry } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import {
  diffPreferences,
  mergePreferences,
  toggleChannel,
  type MergedPreference,
} from "../lib/preference-merge";
import { runOptimistic } from "../lib/optimistic";

export interface UsePreferencesResult {
  defaults: PreferenceEntry[];
  overrides: PreferenceEntry[];
  merged: MergedPreference[]; // display rows (edited state)
  loading: boolean;
  saving: boolean;
  error: ApiError | null;
  toggle(type: string, channel: NotificationChannel): void;
  save(): Promise<void>;
  reload(): Promise<void>;
}

export function usePreferences(): UsePreferencesResult {
  const { api, toast } = useNotificationDeps();
  const [defaults, setDefaults] = useState<PreferenceEntry[]>([]);
  const [overrides, setOverrides] = useState<PreferenceEntry[]>([]);
  const [baseline, setBaseline] = useState<MergedPreference[]>([]);
  const [merged, setMerged] = useState<MergedPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPreferences();
      const rows = mergePreferences(res.defaults, res.overrides);
      setDefaults(res.defaults);
      setOverrides(res.overrides);
      setBaseline(rows);
      setMerged(rows);
    } catch (err) {
      if (isApiError(err)) setError(err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback((type: string, channel: NotificationChannel) => {
    setMerged((rows) =>
      rows.map((r) => (r.type === type ? toggleChannel(r, channel) : r)),
    );
  }, []);

  const save = useCallback(async () => {
    const entries = diffPreferences(baseline, merged);
    if (entries.length === 0) return; // nothing changed
    setSaving(true);
    const prevBaseline = baseline;
    const prevMerged = merged;
    await runOptimistic<PreferenceEntry[]>(
      {
        optimistic: () => {
          setBaseline(merged); // commit the new baseline optimistically
          return () => {
            setBaseline(prevBaseline);
            setMerged(prevMerged);
          };
        },
        commit: (diff) => api.updatePreferences({ entries: diff }),
      },
      entries,
    )
      .then(() => toast.show("success", "Notification settings saved."))
      .catch(() => toast.show("error", "Could not save settings. Please try again."))
      .finally(() => setSaving(false));
  }, [api, baseline, merged, toast]);

  return { defaults, overrides, merged, loading, saving, error, toggle, save, reload };
}
