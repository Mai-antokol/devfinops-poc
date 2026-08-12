-- access_control.sql
--
-- Grafana's datasource (grafana/provisioning/datasources/postgres.yaml)
-- previously connected as the same `devfinops` superuser the app itself
-- uses. That means any dashboard editor could run arbitrary SQL against
-- the database behind the panel query box — including `SELECT git_email
-- FROM developers`, turning a team-level coaching dashboard into an
-- individual leaderboard one panel edit away, which is explicitly not
-- the design (see db/03_hygiene_and_guardrails.sql and the `developers`
-- table comment in db/01_schema.sql).
--
-- This creates a read-only role scoped to exactly the views the shipped
-- dashboards query (see grafana/provisioning/dashboards/json/
-- grafana-provisioning.json) and deliberately does NOT grant it access
-- to `developers`, raw_spans, or raw_events. Extend the GRANT below one
-- view at a time if a future panel needs more — resist "GRANT SELECT ON
-- ALL TABLES IN SCHEMA public", since that's exactly the blanket access
-- this file exists to remove.
--
-- git_commits IS granted (below) — its developer_id column is already
-- the same salted hash as everywhere else, never the plain git_email
-- (that only ever lives in `developers`), so exposing it carries the
-- same coaching-not-leaderboard posture as session_rollups.
--
-- Password is a POC-appropriate placeholder, same as POSTGRES_PASSWORD /
-- JIRA_WEBHOOK_SECRET elsewhere in this repo — rotate it for anything
-- beyond a laptop demo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    CREATE ROLE grafana_reader LOGIN PASSWORD 'grafana_reader';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE devfinops TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;

-- Views run with the privileges of their owner (the devfinops superuser
-- that ran these init scripts), so grafana_reader only needs SELECT on
-- the views themselves, not on the tables underneath them (jira_issues,
-- rate_config, raw_events, etc.) — except session_rollups, which two of
-- the shipped panels JOIN against directly in their own SQL.
GRANT SELECT ON
    ticket_rollup,
    session_rollups,
    testing_discipline_daily,
    prompt_thrash_by_session,
    subagent_fanout_by_session,
    guardrail_blocks_daily,
    git_commits
TO grafana_reader;
