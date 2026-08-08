-- hygiene_and_guardrails.sql
--
-- Supporting views for the "Team AI Hygiene" and "Agent & Guardrails
-- Health" Grafana panels. These are intentionally simple, team-level
-- aggregates (see the earlier discussion on framing this as coaching
-- data, not individual scoring) — no per-developer breakdown here by
-- default.

-- Test-command detection: adjust this pattern list to your team's actual
-- test runners.
CREATE OR REPLACE VIEW test_run_events AS
SELECT *
FROM raw_events
WHERE event_name = 'tool_result'
  AND tool_name = 'Bash'
  AND full_command ~* '(pytest|npm test|npm run test|yarn test|go test|jest|mvn test|cargo test)';

-- A "commit event" — Bash tool_result running `git commit`.
CREATE OR REPLACE VIEW commit_events AS
SELECT *
FROM raw_events
WHERE event_name = 'tool_result'
  AND tool_name = 'Bash'
  AND full_command ~* '^\s*git\s+commit';

-- Testing discipline rate: of all commit events, what fraction had a
-- passing test-run event earlier in the same session.
CREATE OR REPLACE VIEW testing_discipline_daily AS
SELECT
    date_trunc('day', c.ts)                                        AS day,
    COUNT(*)                                                        AS commit_count,
    COUNT(*) FILTER (
        WHERE EXISTS (
            SELECT 1 FROM test_run_events t
            WHERE t.session_id = c.session_id
              AND t.ts < c.ts
              AND t.success = true
        )
    )                                                                AS commits_with_prior_passing_test,
    ROUND(
        100.0 * COUNT(*) FILTER (
            WHERE EXISTS (
                SELECT 1 FROM test_run_events t
                WHERE t.session_id = c.session_id
                  AND t.ts < c.ts
                  AND t.success = true
            )
        ) / NULLIF(COUNT(*), 0),
        1
    )                                                                AS testing_discipline_pct
FROM commit_events c
GROUP BY 1
ORDER BY 1;

-- Prompt thrashing ratio: prompts submitted vs. actual code-mutating tool
-- calls (Edit/Write), per session. High ratio = lots of back-and-forth
-- for little code output. This is a structural proxy, not a judgment —
-- see the earlier discussion on why raw prompt content isn't used here.
CREATE OR REPLACE VIEW prompt_thrash_by_session AS
SELECT
    session_id,
    issue_key,
    COUNT(*) FILTER (WHERE event_name = 'user_prompt')                          AS prompt_count,
    COUNT(*) FILTER (WHERE event_name = 'tool_result' AND tool_name IN ('Edit','Write')) AS mutation_count,
    ROUND(
        COUNT(*) FILTER (WHERE event_name = 'user_prompt')::numeric
        / GREATEST(COUNT(*) FILTER (WHERE event_name = 'tool_result' AND tool_name IN ('Edit','Write')), 1),
        2
    )                                                                            AS thrash_ratio
FROM raw_events
GROUP BY session_id, issue_key;

-- Subagent fan-out per session. Relies on span_kind = 'llm_request' spans
-- carrying an agent_id attribute for subagent calls (absent on
-- main-thread spans) — see the OTel span attribute list in raw_payload.
-- For the POC, we approximate fan-out via distinct trace_id count beyond
-- the session's primary trace, since agent_id isn't broken out as its
-- own column yet (add one in ingest.js if you need this exact).
CREATE OR REPLACE VIEW subagent_fanout_by_session AS
SELECT
    session_id,
    issue_key,
    COUNT(DISTINCT trace_id) - 1 AS subagent_trace_count -- -1 excludes the main session trace
FROM raw_spans
WHERE session_id IS NOT NULL
GROUP BY session_id, issue_key
HAVING COUNT(DISTINCT trace_id) > 1;

-- Guardrail blocks over time, by reason.
CREATE OR REPLACE VIEW guardrail_blocks_daily AS
SELECT
    date_trunc('day', blocked_at) AS day,
    reason,
    COUNT(*) AS block_count
FROM guardrail_blocks
GROUP BY 1, 2
ORDER BY 1;
