-- deploy-service D1 schema (deploy_* namespace on the shared dub-core DB).
-- Semantic source of truth = design §3. Physical aggregation to
-- infra/d1/migrations/deploy/ is the #28 integration step (kept in-service here so
-- this unit stays self-contained; see NOTES).
-- Conventions: no DEFAULT on time columns (values via nowIso), status enum matches
-- the frozen @dub/types deploy.DeploymentStatus (queued|building|live|failed).

CREATE TABLE deploy_sites (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  domain          TEXT,
  cf_project_name TEXT NOT NULL,
  zone_id         TEXT,
  default_branch  TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE deploy_deployments (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL REFERENCES deploy_sites(id),
  cf_deployment_id TEXT,
  status           TEXT NOT NULL
                   CHECK (status IN ('queued','building','live','failed')),
  branch           TEXT NOT NULL,
  commit_sha       TEXT,
  url              TEXT,
  requested_by     TEXT NOT NULL,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX idx_deploy_deployments_site
  ON deploy_deployments(site_id, created_at DESC);
CREATE INDEX idx_deploy_deployments_status
  ON deploy_deployments(status);

CREATE TABLE deploy_allowed_zones (
  zone_id           TEXT PRIMARY KEY,
  zone_name         TEXT NOT NULL UNIQUE,
  registrar_managed INTEGER NOT NULL,
  added_by          TEXT NOT NULL,
  added_at          TEXT NOT NULL
);

CREATE TABLE deploy_dns_changes (
  id             TEXT PRIMARY KEY,
  zone_id        TEXT NOT NULL,
  record_id      TEXT,
  op             TEXT NOT NULL CHECK (op IN ('create','update','delete')),
  record_type    TEXT NOT NULL,
  record_name    TEXT NOT NULL,
  record_content TEXT,
  requested_by   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('applied','failed')),
  error_message  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_deploy_dns_changes_zone
  ON deploy_dns_changes(zone_id, created_at DESC);
