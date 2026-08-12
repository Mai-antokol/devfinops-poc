#!/usr/bin/env node
'use strict';

/**
 * jira-listener.js
 *
 * Minimal webhook receiver for Jira Cloud `jira:issue_updated` (and
 * `jira:issue_created`) events. Keeps the local `jira_issues` table in
 * sync with issue key, summary, status, story points, and issue type —
 * ticket *context* only. Deliberately does not touch worklogs; there is
 * no code path here that writes time back to Jira.
 *
 * For the POC, auth is a shared-secret header check rather than full
 * OAuth 2.0 (3LO) — swap this out before pointing it at a real customer
 * Jira instance (see the Atlassian Marketplace app note from earlier).
 *
 * Usage:
 *   DATABASE_URL=postgres://... JIRA_WEBHOOK_SECRET=changeme \
 *     node jira-listener.js
 */

const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://devfinops:devfinops@localhost:5432/devfinops';
const WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || 'changeme';
// Separate secret from JIRA_WEBHOOK_SECRET — a CI system is a different
// trust boundary than Jira, and rotating one shouldn't force rotating both.
const CI_WEBHOOK_SECRET = process.env.CI_WEBHOOK_SECRET || 'changeme';

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json({ limit: '2mb' }));

// Jira sends story points under a custom field whose ID varies per Jira
// instance (e.g. customfield_10016). Configure it via env rather than
// hardcoding, since it's genuinely instance-specific.
const STORY_POINTS_FIELD = process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10016';

function checkAuth(req, res, next) {
  const provided = req.header('x-devfinops-webhook-secret');
  if (provided !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid webhook secret' });
  }
  next();
}

function checkCiAuth(req, res, next) {
  const provided = req.header('x-devfinops-webhook-secret');
  if (provided !== CI_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid webhook secret' });
  }
  next();
}

// Deliberately provider-agnostic — this table's job is "did tests/build
// pass for this commit," not "what did GitHub Actions/CircleCI/Jenkins
// call it." Whatever CI system posts here maps its own vocabulary
// (success/failure, passed/failed, ...) down to this small set.
const CI_STATUSES = ['success', 'failure', 'error', 'pending', 'cancelled'];

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/webhooks/jira', checkAuth, async (req, res) => {
  const body = req.body || {};
  const issue = body.issue;

  if (!issue || !issue.key) {
    return res.status(400).json({ error: 'payload missing issue.key' });
  }

  const fields = issue.fields || {};
  const issueKey = issue.key;
  const summary = fields.summary || null;
  const status = fields.status?.name || null;
  const issueType = fields.issuetype?.name || null;
  const storyPoints = fields[STORY_POINTS_FIELD] ?? null;
  // Jira Cloud can hide this per-workspace privacy settings even when an
  // assignee is set — null here doesn't necessarily mean "unassigned".
  const assigneeEmail = fields.assignee?.emailAddress || null;

  try {
    await pool.query(
      `INSERT INTO jira_issues (issue_key, summary, status, story_points, issue_type, assignee_email, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (issue_key) DO UPDATE SET
         summary        = EXCLUDED.summary,
         status         = EXCLUDED.status,
         story_points   = EXCLUDED.story_points,
         issue_type     = EXCLUDED.issue_type,
         assignee_email = EXCLUDED.assignee_email,
         updated_at     = now()`,
      [issueKey, summary, status, storyPoints, issueType, assigneeEmail]
    );

    console.log(`[jira-listener] upserted ${issueKey} (status=${status})`);
    res.status(204).send();
  } catch (err) {
    console.error('[jira-listener] failed to upsert issue:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Generic CI webhook — the authoritative source for whether tests/builds
// actually passed or failed for a commit, as opposed to inferring it from
// telemetry (which, per the local-hook signals above, deliberately never
// sees raw command output). Point any CI system's "on completion" webhook
// here with a simple JSON body:
//   { commit_sha, check_name?, status, url?, started_at?, completed_at? }
// check_name defaults to "default" for setups with a single check; give
// it a real name (e.g. "unit-tests", "build") for setups with several
// checks per commit, since (commit_sha, check_name) is the upsert key.
app.post('/webhooks/ci', checkCiAuth, async (req, res) => {
  const body = req.body || {};
  const commitSha = body.commit_sha;
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : null;

  if (!commitSha) {
    return res.status(400).json({ error: 'payload missing commit_sha' });
  }
  if (!status || !CI_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${CI_STATUSES.join(', ')}` });
  }

  const checkName = body.check_name || 'default';
  const url = body.url || null;
  const startedAt = body.started_at || null;
  const completedAt = body.completed_at || null;

  try {
    await pool.query(
      `INSERT INTO ci_runs (commit_sha, check_name, status, url, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (commit_sha, check_name) DO UPDATE SET
         status       = EXCLUDED.status,
         url          = EXCLUDED.url,
         started_at   = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         ingested_at  = now()`,
      [commitSha, checkName, status, url, startedAt, completedAt]
    );

    console.log(`[jira-listener] upserted ci_run ${commitSha} (${checkName}=${status})`);
    res.status(204).send();
  } catch (err) {
    console.error('[jira-listener] failed to upsert ci_run:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`[jira-listener] listening on :${PORT}`);
  console.log(`[jira-listener] webhook path: POST /webhooks/jira`);
  console.log(`[jira-listener] webhook path: POST /webhooks/ci`);
});
