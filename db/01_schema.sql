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
    developer_id      TEXT,               -- pseudonymous hash of developer.id resource attribute (see hashDeveloperId() in ingest.js) — real identity lives only in the `developers` table
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

CREATE INDEX IF NOT EXISTS idx_raw_spans_session     ON raw_spans (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_issue_key   ON raw_spans (issue_key);
CREATE INDEX IF NOT EXISTS idx_raw_spans_developer   ON raw_spans (developer_id);
CREATE INDEX IF NOT EXISTS idx_raw_spans_kind        ON raw_spans (span_kind);
-- Lets db/04_derive_session_rollups.sql's touched_sessions CTE find
-- "what changed since the last derive run" as a cheap index range scan
-- instead of a full-table scan.
CREATE INDEX IF NOT EXISTS idx_raw_spans_ingested_at ON raw_spans (ingested_at);

CREATE TABLE IF NOT EXISTS raw_events (
    event_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id        TEXT,
    prompt_id         TEXT,
    issue_key         TEXT,
    developer_id      TEXT,               -- pseudonymous hash, see raw_spans.developer_id
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
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- de-dup guard: same session+event_name+ts+tool_name shouldn't be
-- inserted twice if the ingestion service is re-run over the same file.
-- This is an expression index on COALESCE(tool_name, ''), not a plain
-- UNIQUE(...) column constraint, because Postgres treats NULL <> NULL in
-- unique constraints — a plain constraint silently never de-dupes any
-- event without a tool_name (user_prompt, stop, api_request, ...), which
-- is most events. ingest.js's ON CONFLICT target must match this exactly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_events_dedup
    ON raw_events (session_id, event_name, ts, (COALESCE(tool_name, '')));

CREATE INDEX IF NOT EXISTS idx_raw_events_session     ON raw_events (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_issue_key   ON raw_events (issue_key);
CREATE INDEX IF NOT EXISTS idx_raw_events_developer   ON raw_events (developer_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_name        ON raw_events (event_name);
CREATE INDEX IF NOT EXISTS idx_raw_events_ts          ON raw_events (ts);
CREATE INDEX IF NOT EXISTS idx_raw_events_ingested_at ON raw_events (ingested_at);

-- ---------------------------------------------------------------------
-- Derived rollups (populated by db/derive_session_rollups.sql)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_rollups (
    session_id        TEXT PRIMARY KEY,
    issue_key         TEXT NOT NULL,
    developer_id      TEXT NOT NULL DEFAULT 'UNATTRIBUTED',
    active_time_sec   NUMERIC NOT NULL DEFAULT 0,
    wait_time_sec     NUMERIC NOT NULL DEFAULT 0,
    token_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
    session_start     TIMESTAMPTZ,
    session_end       TIMESTAMPTZ,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 'explicit'    — issue_key came from --issue or the branch-name regex
    --                 at session time (see cli-wrapper/devfinops-claude.js).
    --                 This is also the value for UNATTRIBUTED sessions —
    --                 "explicit" describes how the field was set, not
    --                 whether it resolved to a real ticket.
    -- 'ai_confirmed' — a human confirmed a session_attribution_suggestions
    --                 row and issue_key was promoted from UNATTRIBUTED.
    --                 db/04_derive_session_rollups.sql's UPSERT preserves
    --                 this on every subsequent ingest re-run instead of
    --                 recomputing issue_key back to UNATTRIBUTED — see its
    --                 own comment before changing that logic.
    attribution_source TEXT NOT NULL DEFAULT 'explicit'
        CHECK (attribution_source IN ('explicit', 'ai_confirmed'))
);

CREATE INDEX IF NOT EXISTS idx_session_rollups_issue_key ON session_rollups (issue_key);
CREATE INDEX IF NOT EXISTS idx_session_rollups_developer ON session_rollups (developer_id);

-- Single-row watermark so db/04_derive_session_rollups.sql only
-- recomputes sessions with data ingested since the last successful run,
-- instead of re-aggregating all of raw_spans/raw_events every time.
-- '-infinity' as the bootstrap default means the very first run (or a
-- fresh container) does a full recompute, same as before this existed.
-- Only advanced by ingest.js after the derive query actually succeeds —
-- if it fails partway, the next run's scope naturally still includes
-- whatever was missed, rather than silently skipping it forever.
CREATE TABLE IF NOT EXISTS derive_watermark (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_derived_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);
INSERT INTO derive_watermark (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Jira context (Step 3) — status/summary only, no worklogs
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jira_issues (
    issue_key         TEXT PRIMARY KEY,
    summary           TEXT,
    status            TEXT,
    story_points       NUMERIC,
    issue_type        TEXT,
    assignee_email    TEXT,               -- fields.assignee.emailAddress; null if unassigned or hidden by the workspace's privacy settings
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- AI-inferred ticket attribution (review queue, not a source of truth).
--
-- Populated by a future backend job for sessions that land UNATTRIBUTED
-- and don't resolve via the single-candidate shortcut (exactly one Jira
-- ticket in an active status assigned to the developer). Deliberately
-- separate from session_rollups: a suggestion here NEVER feeds
-- ticket_rollup / c_total_usd on its own — see the attribution edge-cases
-- memo on why an unconfirmed guess must never share a column with a
-- measured number. It only affects cost data once a human reviews it and
-- session_rollups.issue_key is explicitly promoted (attribution_source
-- becomes 'ai_confirmed').
--
-- signals_used is JSONB, not fixed columns, on purpose: today it holds
-- privacy-safe signals only (tool commands, file paths, commit
-- subjects). If prompt-content opt-in ever ships, a richer payload (e.g.
-- a prompt excerpt) fits in the same column with no migration.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_attribution_suggestions (
    suggestion_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id           TEXT NOT NULL,
    suggested_issue_key  TEXT NOT NULL,
    confidence_score     NUMERIC(4,3),     -- the model's self-reported score — NOT a calibrated probability, see the memo before wiring an auto-accept threshold to it
    rationale             TEXT,             -- the model's explanation, for a human reviewer — never just the number
    signals_used          JSONB,
    model_version         TEXT,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'rejected')),
    suggested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by           TEXT,             -- developer_id (hashed) of whoever confirmed/rejected — see the `developers` table, same pseudonymization as everywhere else
    reviewed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_attribution_suggestions_session ON session_attribution_suggestions (session_id);
CREATE INDEX IF NOT EXISTS idx_session_attribution_suggestions_status  ON session_attribution_suggestions (status);

-- ---------------------------------------------------------------------
-- Developer identity mapping (access-control boundary).
--
-- raw_spans.developer_id / raw_events.developer_id / session_rollups.
-- developer_id / git_commits.developer_id are all a salted hash of the
-- developer's git identity (see hashDeveloperId() in ingest.js), never
-- the plain email — this table is the *only* place a real git_email
-- lives. The point: Grafana's dashboards query session_rollups and
-- ticket_rollup directly (see grafana/provisioning), so if a plain email
-- sat in those tables, any dashboard editor is one panel edit away from
-- an individual leaderboard, which is explicitly not the design (see
-- db/03_hygiene_and_guardrails.sql's "team-level aggregates... no
-- per-developer breakdown by default"). db/05_access_control.sql grants
-- Grafana's DB role SELECT on the rollup views and NOT on this table —
-- looking up who developer_id 'a1b2c3...' actually is requires that
-- separate, more restricted access path.
--
-- jira_account_id is intentionally left unpopulated for now: a
-- developer's local `git config user.email` is often a personal or
-- legacy address and isn't guaranteed to match their Jira/SSO account.
-- Populate it via an explicit identity-mapping step later — don't join
-- git_email to Jira assignee fields by assuming string equality.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS developers (
    developer_id      TEXT PRIMARY KEY,   -- sha256(salt || git identity), truncated
    git_email         TEXT UNIQUE,        -- populated when the git identity was an email
    display_name      TEXT,               -- populated when it fell back to git user.name instead
    jira_account_id   TEXT,               -- reserved — see note above, not populated yet
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Git commit correlation (Step 4) — links a devfinops session to the
-- actual commit(s) it produced. Populated from git_commits.jsonl, which
-- the post-commit hook (cli-wrapper/git-hooks/post-commit) appends to
-- whenever a commit carries a Session-Id trailer stamped by
-- prepare-commit-msg. Commits made outside a devfinops-claude session
-- never reach this table — see ingestGitCommits() in ingest.js.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS git_commits (
    commit_sha        TEXT PRIMARY KEY,
    session_id        TEXT,               -- joins to session_rollups.session_id
    issue_key         TEXT,               -- from the Jira-Issue trailer, may be null
    developer_id      TEXT,               -- pseudonymous, hashed the same way as raw_spans.developer_id (see ingest.js) — joins to developers.developer_id
    subject           TEXT,
    files_changed     INTEGER NOT NULL DEFAULT 0,
    insertions        INTEGER NOT NULL DEFAULT 0,
    deletions         INTEGER NOT NULL DEFAULT 0,
    committed_at      TIMESTAMPTZ,
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_git_commits_session      ON git_commits (session_id);
CREATE INDEX IF NOT EXISTS idx_git_commits_issue_key    ON git_commits (issue_key);
-- Lets reconcileMissingJiraIssues() in ingest.js scope its candidate
-- search to rows ingested since jira_reconcile_watermark, same reasoning
-- as raw_spans/raw_events' ingested_at indexes.
CREATE INDEX IF NOT EXISTS idx_git_commits_ingested_at  ON git_commits (ingested_at);

-- Single-row watermark for reconcileMissingJiraIssues() in ingest.js —
-- same shape as derive_watermark above, but bootstraps at 'epoch'
-- (1970-01-01) instead of '-infinity'. Deliberately different: this
-- watermark is only ever read/written from ingest.js (never needs to
-- run standalone via psql the way db/04_derive_session_rollups.sql
-- does), and node-postgres parses '-infinity'/'infinity' as the JS
-- primitives -Infinity/Infinity, not a Date -- 'epoch' round-trips as a
-- normal, finite Date with no special-casing needed, and is still
-- guaranteed earlier than any real telemetry.
--
-- Tradeoff, chosen deliberately (see the attribution edge-cases /
-- reconciliation discussion): once a key's underlying row falls behind
-- this watermark, it stops being a candidate for auto-fetch — including
-- a key that only ever failed (Jira down, deleted ticket, typo'd branch
-- name). That's intentional: it bounds a permanently-broken key to a
-- finite number of retries instead of hitting the Jira API on every
-- single run forever. It also means a transient failure won't
-- auto-retry once it's aged out — fetch-ticket.js remains the manual
-- escape hatch for that. A cooldown-based retry table is the natural
-- next step if this tradeoff turns out to bite in practice.
CREATE TABLE IF NOT EXISTS jira_reconcile_watermark (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);
INSERT INTO jira_reconcile_watermark (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Privacy-safe local-hook signals — see cli-wrapper/claude-hooks/.
-- Structured metadata derived LOCALLY from prompt/command text before
-- Claude Code's own telemetry pipeline ever runs, with the raw text
-- discarded immediately after classification in the hook process itself
-- — never transmitted, never persisted anywhere, including here. A
-- narrower, different privacy posture than Claude Code's own
-- OTEL_LOG_USER_PROMPTS / OTEL_LOG_TOOL_CONTENT flags, which transmit
-- full raw content once enabled.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prompt_signals (
    signal_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      TEXT,
    issue_key       TEXT,
    developer_id    TEXT,               -- pseudonymous, hashed at ingest same as everywhere else
    intent          TEXT,               -- bug_fix | test | refactor | feature | other
    mentions_tests  BOOLEAN,
    prompt_length   INTEGER,
    ts              TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prompt_signals_session     ON prompt_signals (session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_signals_ingested_at ON prompt_signals (ingested_at);

CREATE TABLE IF NOT EXISTS tool_signals (
    signal_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      TEXT,
    issue_key       TEXT,
    developer_id    TEXT,
    category        TEXT,               -- test | build | git | other
    ts              TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_signals_session     ON tool_signals (session_id);
CREATE INDEX IF NOT EXISTS idx_tool_signals_ingested_at ON tool_signals (ingested_at);

-- ---------------------------------------------------------------------
-- CI outcomes — the authoritative source for whether tests/builds
-- actually passed, posted by any CI provider via POST /webhooks/ci on
-- jira-listener.js (see that file). Deliberately provider-agnostic: a
-- generic (commit_sha, check_name, status) shape rather than one CI
-- system's native webhook payload, so this isn't locked to GitHub
-- Actions vs. GitLab CI vs. Jenkins etc.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ci_runs (
    ci_run_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commit_sha    TEXT NOT NULL,
    check_name    TEXT NOT NULL DEFAULT 'default',
    status        TEXT NOT NULL,        -- success | failure | error | cancelled | pending
    url           TEXT,
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (commit_sha, check_name)
);

CREATE INDEX IF NOT EXISTS idx_ci_runs_commit_sha ON ci_runs (commit_sha);

-- ---------------------------------------------------------------------
-- Ingestion cursors — lets ingest.js resume each landing-zone file from
-- where it left off instead of re-reading from byte zero every run.
--
-- file_inode identifies the physical file, not just the path: the OTel
-- Collector's rotation renames the current file to a backup name and
-- starts a fresh file at the same path, so byte_offset alone can't tell
-- "new file, smaller" apart from "same file, hasn't grown yet" — and
-- comparing offset > current size specifically fails if the new file
-- grows past the old offset before the next ingest run, which would
-- silently skip the start of the new file instead of catching the
-- rotation. An inode mismatch is unambiguous either way.
--
-- Rotation is detected correctly, but this does NOT retroactively read
-- data left unread in a file before it got rotated away — that data
-- only exists in a numbered backup file ingest.js never looks at. See
-- the README's ingest-frequency guidance: this makes each run cheaper,
-- it doesn't remove the need to run often enough to stay ahead of
-- rotation (100MB / 7 days, 10 backups — collector-config/).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_cursors (
    file_name    TEXT PRIMARY KEY,   -- 'traces.jsonl' | 'logs.jsonl' | 'git_commits.jsonl'
    file_inode   BIGINT,             -- null until the file has been read at least once
    byte_offset  BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
