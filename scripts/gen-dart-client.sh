#!/usr/bin/env bash
#
# Generate the Dart (dart-dio) gateway client from the OpenAPI SoT.
#
# The generated client is the ONLY way the Flutter desktop app talks to the
# api-gateway. Hand-writing gateway calls is forbidden (roadmap §3): the client
# keys must equal the OpenAPI field names, so there is no place to write an
# alias and drift the wire contract (the class of bug that hit gantt in PR#231).
#
# Contract is committed. CI runs this script and fails if `git diff` is dirty
# afterwards ("regenerate → diff = red"), so a stale client cannot be merged.
#
# Requirements ($0, no runtime deps):
#   - openapi-generator 7.x  (brew install openapi-generator — needs a JDK)
#   - dart / flutter         (for `dart run build_runner build`)
#
# Usage:
#   scripts/gen-dart-client.sh            # generate + build_runner
#   scripts/gen-dart-client.sh --check    # generate into a temp dir, fail on diff
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="${REPO_ROOT}/docs/openapi/api-gateway.yaml"
OUT="${REPO_ROOT}/packages/api-client-dart"
GENERATOR_VERSION="7.24.0" # pinned; bump deliberately and re-commit the diff

# P0 scope: only the api-gateway boundary (the single external surface every
# client talks to). Per-service specs are proxied through the gateway, so one
# client covers /me, /bff/home and the transparent proxy. Add more inputs here
# as service-specific typed clients are introduced.
PROPS="pubName=dub_api_client,pubLibrary=dub_api_client.api,pubAuthor=DevelopersHub,nullableFields=false"

if ! command -v openapi-generator >/dev/null 2>&1; then
  echo "error: openapi-generator not found. Install: brew install openapi-generator" >&2
  exit 1
fi

FOUND_VERSION="$(openapi-generator version 2>/dev/null || true)"
if [ "${FOUND_VERSION}" != "${GENERATOR_VERSION}" ]; then
  echo "warning: openapi-generator ${FOUND_VERSION} != pinned ${GENERATOR_VERSION}; output may differ" >&2
fi

echo "==> generating dart-dio client into ${OUT}"
rm -rf "${OUT}/lib" "${OUT}/doc" "${OUT}/test" "${OUT}/.openapi-generator"
openapi-generator generate \
  -i "${SPEC}" \
  -g dart-dio \
  -o "${OUT}" \
  --additional-properties="${PROPS}"

echo "==> running build_runner (built_value serializers)"
( cd "${OUT}" && dart pub get >/dev/null && dart run build_runner build )

if [ "${1:-}" = "--check" ]; then
  echo "==> checking generated client is committed and fresh"
  if ! git -C "${REPO_ROOT}" diff --quiet -- "${OUT}"; then
    echo "error: generated Dart client is stale. Run scripts/gen-dart-client.sh and commit." >&2
    git -C "${REPO_ROOT}" --no-pager diff --stat -- "${OUT}" >&2
    exit 1
  fi
  echo "==> up to date"
fi

echo "==> done"
