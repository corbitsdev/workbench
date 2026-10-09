#!/bin/bash
# Postgres initdb bootstrap for the DB-gated e2e suites. Runs once when the
# container's data directory is first initialized (before any client connects),
# so it must finish before pg_isready's healthcheck reports ready.
#
# DATABASE_URL points at `workbench`, but every DB-gated e2e suite redirects to
# the derived `_e2e` sibling (`workbench_e2e` — see e2e/lib/database-url.ts and
# scripts/db-setup.ts) and owns that database outright. The postgres service
# `POSTGRES_DB` env creates only the base database, so this script creates the
# sibling too; otherwise a fresh CI e2e job boots DB-gated suites straight into
# a `3D000` "database does not exist" from the hub.
set -euo pipefail

# POSTGRES_DB (`workbench`) is created by the image before initdb.d scripts
# run; the sibling is derived the same way e2e/lib/database-url.ts does it.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
SELECT 'CREATE DATABASE workbench_e2e OWNER "postgres"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'workbench_e2e')\gexec
SQL