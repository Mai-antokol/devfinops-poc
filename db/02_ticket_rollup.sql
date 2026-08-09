-- ticket_rollup.sql
--
-- Per-ticket unit economics:
--   C_total = (T_active_hours * hourly_rate_usd) + token_cost_usd
--
-- Joins session_rollups (grouped by issue_key, since a ticket typically
-- spans multiple Claude Code sessions) with jira_issues for ticket
-- context and rate_config for the hourly rate. Recreate this view any
-- time the schema changes; it always reflects the latest session_rollups
-- data since it's a plain view, not a materialized snapshot.

CREATE OR REPLACE VIEW ticket_rollup AS
SELECT
    sr.issue_key,
    ji.summary,
    ji.status,
    ji.story_points,
    ji.issue_type,
    COUNT(DISTINCT sr.session_id)                              AS session_count,
    COUNT(DISTINCT sr.developer_id)                            AS developer_count,
    ARRAY_AGG(DISTINCT sr.developer_id)                        AS developers,
    ROUND(SUM(sr.active_time_sec) / 3600.0, 3)                 AS active_time_hours,
    ROUND(SUM(sr.wait_time_sec) / 3600.0, 3)                   AS wait_time_hours,
    ROUND(SUM(sr.token_cost_usd), 4)                           AS token_cost_usd,
    rc.hourly_rate_usd,
    ROUND(
        (SUM(sr.active_time_sec) / 3600.0) * rc.hourly_rate_usd
        + SUM(sr.token_cost_usd),
        2
    )                                                            AS c_total_usd,
    MIN(sr.session_start)                                       AS ticket_first_session,
    MAX(sr.session_end)                                          AS ticket_last_session
FROM session_rollups sr
LEFT JOIN jira_issues ji ON ji.issue_key = sr.issue_key
CROSS JOIN (
    SELECT hourly_rate_usd FROM rate_config WHERE team = 'default'
) rc
GROUP BY
    sr.issue_key, ji.summary, ji.status, ji.story_points, ji.issue_type,
    rc.hourly_rate_usd
ORDER BY c_total_usd DESC;
