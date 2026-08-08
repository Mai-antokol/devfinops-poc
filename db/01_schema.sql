-- DevFinOps POC schema
--
-- Design notes:
--   * raw_spans / raw_events keep the full OTLP payload in `raw_payload jsonb`
--     alongside a handful of extracted, typed columns. This is deliberate —
--     see the ELT landing-zone discussion: the beta trace schema will shift
--     under us, and we don't want to lose data to a premature extraction
--     decision. Extracted columns are "the fields we're confident we need
--     today"; raw_payload is the safety net.
--   * All ingestion is idempotent (ON CONFLICT DO NOTHING / UPSERT) keyed on
--     the OTel-provided IDs, since the ingestion service in Step 2 may be
--     re-run against the same landing-zone files during development.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- Raw landing tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS raw_spans (
    span_id           TEXT PRIMARY KEY,
    parent_span_id    TEXT,
    trace_id          TEXT NOT NULL,
    session_id        TEXT,
    prompt_id         TEXT,
    issue_key         TEXT,               -- from jira.issue_key resource attribute
    span_name         TEXT NOT NULL,      -- e.g. claude_code.interaction, tool_execution, llm_request
    span_kind         TEXT,               -- our own classification: 'interaction' | 'tool' | 'llm_request' | 'other'
    tool_name         TEXT,               -- populated when span_kind = 'tool'
    start_ts          TIMESTAMPTZ NOT NULL,
    end_ts             TIMESTAMPTZ NOT NULL,
    duration_ms       NUMERIC GENERATED ALWAYS AS (
                          EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000
                      ) STORED,
    cost_usd          NUMERIC(12,6) DEFAULT 0,
    input_tokens      BIGINT DEFAULT 0,
    output_tokens     BIGINT DEFAULT 0,
    raw_payload       JSONB NOT NULL,
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_spans_session   ON raw_spans (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_issue_key ON raw_spans (issue_key);
CREATE INDEX IF NOT EXISTS idx_raw_spans_kind       ON raw_spans (span_kind);

CREATE TABLE IF NOT EXISTS raw_events (
    event_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id        TEXT,
    prompt_id         TEXT,
    issue_key         TEXT,
    event_name        TEXT NOT NULL,      -- user_prompt, api_request, tool_result, tool_decision, stop, ...
    ts                TIMESTAMPTZ NOT NULL,
    tool_name         TEXT,
    full_command      TEXT,               -- extracted from tool_parameters for Bash tool_result events
    decision          TEXT,               -- accept | reject, on tool_decision events
    success           BOOLEAN,
    cost_usd          NUMERIC(12,6) DEFAULT 0,
    input_tokens      BIGINT DEFAULT 0,
    output_tokens     BIGINT DEFAULT 0,
    raw_payload       JSONB NOT NULL,
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- de-dup guard: same session+event_name+ts+tool_name shouldn't be
    -- inserted twice if the ingestion service is re-run over the same file
    UNIQUE (session_id, event_name, ts, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_raw_events_session   ON raw_events (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_issue_key ON raw_events (issue_key);
CREATE INDEX IF NOT EXISTS idx_raw_events_name      ON raw_events (event_name);
CREATE INDEX IF NOT EXISTS idx_raw_events_ts         ON raw_events (ts);

-- ---------------------------------------------------------------------
-- Derived rollups (populated by db/derive_session_rollups.sql)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_rollups (
    session_id        TEXT PRIMARY KEY,
    issue_key         TEXT NOT NULL,
    active_time_sec   NUMERIC NOT NULL DEFAULT 0,
    wait_time_sec     NUMERIC NOT NULL DEFAULT 0,
    token_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
    session_start     TIMESTAMPTZ,
    session_end       TIMESTAMPTZ,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_rollups_issue_key ON session_rollups (issue_key);

-- ---------------------------------------------------------------------
-- Jira context (Step 3) — status/summary only, no worklogs
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jira_issues (
    issue_key         TEXT PRIMARY KEY,
    summary           TEXT,
    status            TEXT,
    story_points       NUMERIC,
    issue_type        TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Config: hourly rate used in unit-economics calculation.
-- Kept as a table (not a hardcoded constant) so it can vary per team
-- without a code change. Single-row default for the POC.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_config (
    team              TEXT PRIMARY KEY DEFAULT 'default',
    hourly_rate_usd   NUMERIC(10,2) NOT NULL
);

INSERT INTO rate_config (team, hourly_rate_usd)
VALUES ('default', 75.00)
ON CONFLICT (team) DO NOTHING;

-- ---------------------------------------------------------------------
-- Guardrail block log (referenced by the Grafana "guardrails health" panel)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guardrail_blocks (
    block_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id        TEXT,
    issue_key         TEXT,
    reason            TEXT,               -- e.g. 'budget_exceeded', 'thrash_detected'
    blocked_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
