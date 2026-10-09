#!/usr/bin/env bash
#
# Staging slot selector — sourced by the staging deploy/gen/setup scripts.
#
# There are TWO independent full-stack staging slots so two PRs can be reviewed at once:
#   slot 1  `-staging`   label `stagingへ`   ALSO follows main (every push:main redeploys it)
#   slot 2  `-staging2`  label `staging2へ`  PR-only (never overwritten by a main merge)
#
# Each slot has its own Worker set (<prod name><suffix>) and its own D1/KV/R2, whose ids live in
# the slot's resources file (same variable names in both files).
#
# Input:  STAGING_SLOT (1|2, default 1)
# Output: STAGING_SUFFIX, STAGING_LABEL, STAGING_RESOURCES_FILE (repo-relative)

STAGING_SLOT="${STAGING_SLOT:-1}"
case "$STAGING_SLOT" in
  1) STAGING_SUFFIX="-staging";  STAGING_LABEL="stagingへ";  STAGING_RESOURCES_FILE="infra/deploy/staging-resources.env" ;;
  2) STAGING_SUFFIX="-staging2"; STAGING_LABEL="staging2へ"; STAGING_RESOURCES_FILE="infra/deploy/staging2-resources.env" ;;
  *) echo "::error::unknown STAGING_SLOT '${STAGING_SLOT}' (want 1|2)" >&2; exit 2 ;;
esac
export STAGING_SLOT STAGING_SUFFIX STAGING_LABEL STAGING_RESOURCES_FILE
