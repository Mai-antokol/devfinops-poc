#!/usr/bin/env node
'use strict';

/**
 * fetch-ticket.js
 *
 * One-shot pull of a single real Jira Cloud issue via REST API v3,
 * upserted into jira_issues the same way the webhook path
 * (jira-listener.js) does. For testing against a real Jira workspace
 * without wiring up a real webhook — no credentials are read from
 * anywhere but process.env / a local .env file, nothing is hardcoded.
 *
 * Required env (see .env.example):
 *   JIRA_HOST        e.g. https://your-domain.atlassian.net
 *   JIRA_USER_EMAIL  the Atlassian account the token belongs to
 *   JIRA_API_TOKEN   generate at
 *     https://id.atlassian.com/manage-profile/security/api-tokens
 *   DATABASE_URL     optional, same default as ingest.js
 *
 * Usage:
 *   node fetch-ticket.js SAM1-11
 */

const path = require('path');
// Loaded from the repo root regardless of which directory this is run
// from, not process.cwd() — see ingest.js's LANDING_ZONE_DIR comment for
// why "relative to cwd" defaults are a recurring footgun in this repo.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');

const { JIRA_HOST, JIRA_USER_EMAIL, JIRA_API_TOKEN } = process.env;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://devfinops:devfinops@localhost:5432/devfinops';

// Same instance-specific custom field as jira-listener.js — Jira Cloud
// doesn't have a fixed field id for story points, see that file's own
// comment. Override with JIRA_STORY_POINTS_FIELD if yours differs.
const STORY_POINTS_FIELD = process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10016';

const issueKey = process.argv[2];

function requireConfig() {
  const missing = ['JIRA_HOST', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[fetch-ticket] missing required env var(s): ${missing.join(', ')} — see .env.example, set them in your .env`);
    process.exit(1);
  }
  if (!issueKey) {
    console.error('[fetch-ticket] usage: node fetch-ticket.js <ISSUE-KEY>   (e.g. SAM1-11)');
    process.exit(1);
  }
}

async function fetchIssue(key) {
  const url = `${JIRA_HOST.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}`;
  const auth = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jira rejected the credentials (HTTP ${res.status}) — check JIRA_USER_EMAIL / JIRA_API_TOKEN in .env`);
  }
  if (res.status === 404) {
    throw new Error(`issue "${key}" not found at ${JIRA_HOST} (HTTP 404) — check the key and JIRA_HOST`);
  }
  if (!res.ok) {
    throw new Error(`Jira API request failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function extractStoryPoints(fields, key) {
  const raw = fields[STORY_POINTS_FIELD];
  if (typeof raw === 'number') return raw;
  if (raw != null) {
    console.warn(
      `[fetch-ticket] ${STORY_POINTS_FIELD} on ${key} isn't numeric (${JSON.stringify(raw)}) — ` +
        `storing null. Your instance's story-points field id may not be the default; ` +
        `set JIRA_STORY_POINTS_FIELD to override.`
    );
  }
  return null;
}

async function main() {
  requireConfig();

  console.log(`[fetch-ticket] fetching ${issueKey} from ${JIRA_HOST}...`);
  const issue = await fetchIssue(issueKey);
  const fields = issue.fields || {};

  const summary = fields.summary || null;
  const status = fields.status?.name || null;
  const issueType = fields.issuetype?.name || null;
  const storyPoints = extractStoryPoints(fields, issue.key);

  console.log(
    `[fetch-ticket] ${issue.key}: "${summary}" — status=${status}, type=${issueType}, points=${storyPoints}`
  );

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO jira_issues (issue_key, summary, status, story_points, issue_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (issue_key) DO UPDATE SET
         summary      = EXCLUDED.summary,
         status       = EXCLUDED.status,
         story_points = EXCLUDED.story_points,
         issue_type   = EXCLUDED.issue_type,
         updated_at   = now()`,
      [issue.key, summary, status, storyPoints, issueType]
    );
    console.log(`[fetch-ticket] upserted ${issue.key} into jira_issues`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[fetch-ticket] error: ${err.message}`);
  process.exit(1);
});
