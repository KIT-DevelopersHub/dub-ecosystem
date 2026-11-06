-- namespace: driveshare | owner: drive-share-service (Google Calendar / Meet call counts)
-- One row per API per UTC minute in which that API was called. usage-meter reads the busiest
-- minute for the 無料枠 dashboard: Google's limits on these APIs are per minute, not per day.
CREATE TABLE driveshare_google_api_usage (
  api    TEXT NOT NULL CHECK (api IN ('calendar','meet')),
  minute TEXT NOT NULL,
  calls  INTEGER NOT NULL,
  PRIMARY KEY (api, minute)
);
