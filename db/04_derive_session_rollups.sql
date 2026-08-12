-- derive_session_rollups.sql
--
-- Computes T_wait and T_active per session and upserts into session_rollups.
-- Safe to re-run repeatedly (e.g. on a cron/schedule) — it's a full
-- recompute per session, not an incremental append.
--
-- T_wait  = sum of tool-execution + llm_request span durations
--           (time Claude/subagents spent actually running)
-- T_active = sum of clamped gaps between a "Stop" event and the next
--            "user_prompt" event (time the developer spent reading/typing)
--
-- Clamping rule (see the idle-time discussion): any single gap is capped
-- at :ceiling_seconds. Gaps below :floor_seconds are never a concern
-- (they're "just reading") and pass through unchanged, since LEAST() only
-- has an effect once the gap exceeds the ceiling. The floor matters once
-- you add the file-mtime/local-activity correlation described earlier —
-- that logic runs client-side in the wrapper, not in this SQL layer, and
-- would land as an explicit `active` boolean per gap for this query to
-- respect instead of blindly clamping. This script implements the
-- SQL-only baseline; treat it as v0.1 of the heuristic.

\set floor_seconds 60
\set ceiling_seconds 900   -- 15 minutes

WITH wait_time AS (
    SELECT
        session_id,
        MAX(issue_key)                     AS issue_key,
        MAX(developer_id)                  AS developer_id,
        SUM(duration_ms) / 1000.0           AS wait_time_sec,
        MIN(start_ts)                       AS session_start,
        MAX(end_ts)                         AS session_end
    FROM raw_spans
    WHERE span_kind IN ('tool', 'llm_request')
      AND session_id IS NOT NULL
    GROUP BY session_id
),

turn_boundaries AS (
    -- Stop and user_prompt events, in order, per session
    SELECT
        session_id,
        issue_key,
        developer_id,
        event_name,
        ts,
        LAG(ts) OVER (PARTITION BY session_id ORDER BY ts)         AS prev_ts,
        LAG(event_name) OVER (PARTITION BY session_id ORDER BY ts) AS prev_event_name
    FROM raw_events
    WHERE event_name IN ('stop', 'user_prompt')
      AND session_id IS NOT NULL
),

active_gaps AS (
    -- A "gap" only counts as active-time candidate when it runs from a
    -- Stop event to the following user_prompt event (developer's turn).
    SELECT
        session_id,
        issue_key,
        developer_id,
        LEAST(
            EXTRACT(EPOCH FROM (ts - prev_ts)),
            :ceiling_seconds
        ) AS clamped_gap_sec
    FROM turn_boundaries
    WHERE event_name = 'user_prompt'
      AND prev_event_name = 'stop'
      AND ts > prev_ts
),

active_time AS (
    SELECT
        session_id,
        MAX(issue_key)              AS issue_key,
        MAX(developer_id)           AS developer_id,
        SUM(clamped_gap_sec)        AS active_time_sec
    FROM active_gaps
    GROUP BY session_id
),

token_cost AS (
    SELECT
        session_id,
        SUM(cost_usd) AS token_cost_usd
    FROM raw_events
    WHERE event_name = 'api_request'
      AND session_id IS NOT NULL
    GROUP BY session_id
)

INSERT INTO session_rollups (
    session_id, issue_key, developer_id, active_time_sec, wait_time_sec,
    token_cost_usd, session_start, session_end, computed_at
)
SELECT
    COALESCE(w.session_id, a.session_id, t.session_id)          AS session_id,
    COALESCE(w.issue_key, a.issue_key, 'UNATTRIBUTED')          AS issue_key,
    COALESCE(w.developer_id, a.developer_id, 'UNATTRIBUTED')    AS developer_id,
    COALESCE(a.active_time_sec, 0)                              AS active_time_sec,
    COALESCE(w.wait_time_sec, 0)                                AS wait_time_sec,
    COALESCE(t.token_cost_usd, 0)                               AS token_cost_usd,
    w.session_start,
    w.session_end,
    now()
FROM wait_time w
FULL OUTER JOIN active_time a ON a.session_id = w.session_id
FULL OUTER JOIN token_cost  t ON t.session_id = COALESCE(w.session_id, a.session_id)
-- issue_key is pinned once a human has promoted an AI-suggested
-- attribution (session_rollups.attribution_source = 'ai_confirmed') —
-- otherwise this full recompute would silently overwrite a confirmed
-- issue_key back to UNATTRIBUTED on every subsequent ingest run, since
-- the raw OTel tag on the underlying spans/events never changes. Every
-- other column, and attribution_source itself, still recomputes
-- normally — attribution_source isn't listed here at all, so ON
-- CONFLICT leaves it untouched, which is what we want.
ON CONFLICT (session_id) DO UPDATE SET
    issue_key       = CASE
                           WHEN session_rollups.attribution_source = 'ai_confirmed'
                           THEN session_rollups.issue_key
                           ELSE EXCLUDED.issue_key
                       END,
    developer_id    = EXCLUDED.developer_id,
    active_time_sec = EXCLUDED.active_time_sec,
    wait_time_sec   = EXCLUDED.wait_time_sec,
    token_cost_usd  = EXCLUDED.token_cost_usd,
    session_start   = EXCLUDED.session_start,
    session_end     = EXCLUDED.session_end,
    computed_at     = now();
