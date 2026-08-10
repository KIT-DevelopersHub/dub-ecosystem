// NotificationPreferencesPage — the /settings/notifications route. Loads the
// merged matrix, edits locally, and saves the diff (FE5 §2-1/§2-2, tests 11,12).

import type { ReactNode } from "react";
import { Button, Card, PageHeader, SkeletonLoader, Stack } from "@dub/ui";
import { usePreferences } from "../hooks/usePreferences";
import { PreferenceMatrix } from "./PreferenceMatrix";

export function NotificationPreferencesPage(): ReactNode {
  const prefs = usePreferences();

  return (
    <Stack gap={4} testId="fe5-prefs-page">
      <PageHeader
        title="Notification settings"
        actions={
          <Button
            variant="primary"
            onClick={() => void prefs.save()}
            loading={prefs.saving}
            disabled={prefs.loading}
            testId="fe5-prefs-save"
          >
            Save changes
          </Button>
        }
        testId="fe5-prefs-header"
      />
      <Card testId="fe5-prefs-card">
        {prefs.loading ? (
          <SkeletonLoader lines={6} testId="fe5-prefs-skeleton" />
        ) : (
          <PreferenceMatrix rows={prefs.merged} onToggle={prefs.toggle} />
        )}
      </Card>
    </Stack>
  );
}

export default NotificationPreferencesPage;
