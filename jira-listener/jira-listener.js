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

app.listen(PORT, () => {
  console.log(`[jira-listener] listening on :${PORT}`);
  console.log(`[jira-listener] webhook path: POST /webhooks/jira`);
});
