#!/usr/bin/env bash
# Ordered, dependency-safe STAGING deploy set (sourced by gen-staging-configs.sh and
# deploy-staging.sh). Mirrors the order in deploy-prod.sh exactly — a bind-target Worker
# must exist before the Worker that binds it. Each entry is the directory holding a
# wrangler.free.toml; the staging config generated next to it is wrangler.staging.toml,
# and its Worker name is the prod free-tier name + "-staging" (done by gen-staging-configs.sh).
#
# NOTE: this is a data file (an array). It is sourced, not executed.

STAGING_WORKER_DIRS=(
  # 1. foundation
  "services/identity-roster"
  # 2. auth (binds SVC_IDENTITY)
  "services/auth-service"
  # 3. peripheral services (order-free among themselves)
  "services/event-service"
  "services/task-service"
  "services/gantt-service"
  "services/notification"
  "services/file-meta"
  "services/drive-proxy"
  "services/drive-share-service"
  "services/chat-service"
  "services/mail-gateway"
  "services/deploy-service"
  "services/github-sync"
  "services/audit-log"
  "services/member-service"
  "services/usage-meter"
  # 4. api-gateway (binds all upstreams)
  "services/api-gateway"
  # 5. fe2 admin SPA (assets; built with the STAGING gateway base URL)
  "apps/fe2-app-shell"
  # 6. mo3 mobile BFF
  "apps/mo3-mobile-bff"
  # 7. app-health-monitor (binds every upstream it probes — deploy last)
  "services/app-health-monitor"
)
