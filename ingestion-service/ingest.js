#!/usr/bin/env node
'use strict';

/**
 * ingest.js
 *
 * Reads the OTel Collector's JSONL landing-zone files (traces.jsonl,
 * logs.jsonl) and loads them into Postgres (raw_spans, raw_events).
 *
 * Incremental, not a full re-read: each file's (inode, byte offset) is
 * tracked in ingest_cursors, so a run only parses what's been appended
 * since the last one — see readNewLines() and the ingest_cursors table
 * comment in db/01_schema.sql for why inode (not offset-vs-size) is what
 * detects the OTel Collector rotating a file out from under us. Rotation
 * is detected safely, but this does NOT go back and read a rotated-away
 * backup file for whatever was left unread in it — run often enough that
 * you don't fall behind rotation (100MB / 7 days, 10 backups; see
 * collector-config/ and the README's ingest-frequency guidance).
 *
 * Run it after a test session, or on a loop/cron in a slightly more
 * built-out version. Idempotent on top of being incremental: re-running
 * against the same already-seen bytes is a no-op (spans are keyed by
 * span_id; events are de-duped via a NULL-safe unique index — see that
 * index's comment in db/01_schema.sql for why a plain UNIQUE constraint
 * silently didn't work here).
 *
 * NOTE ON FIELD NAMES: Claude Code's enhanced-telemetry trace/log schema is
 * beta and the exact attribute keys can shift between versions. Before
 * trusting this in production, `jq` through a real landed file and confirm
 * the attribute names below (ATTR.*) match what your Claude Code version
 * actually emits, and adjust the ATTR map accordingly — that's the whole
 * reason we kept raw_payload alongside the extracted columns.
 *
 * Usage:
 *   DATABASE_URL=postgres://... LANDING_ZONE_DIR=./landing_zone node ingest.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { Pool } = require('pg');

// Resolved relative to the repo root regardless of which directory this
// is run from, same reasoning as LANDING_ZONE_DIR below — see
// jira-listener/fetch-ticket.js for the identical pattern.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Resolved relative to this file, not the current working directory —
// `npm run ingest` is normally invoked from inside ingestion-service/,
// where a `./landing_zone` default would silently point at a directory
// that doesn't exist there instead of the repo-root one the OTel
// Collector actually writes to (same fix as cli-wrapper's landingZoneDir).
const LANDING_ZONE_DIR = process.env.LANDING_ZONE_DIR || path.resolve(__dirname, '..', 'landing_zone');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://devfinops:devfinops@localhost:5432/devfinops';

// Auto-fetch config for reconcileMissingJiraIssues() below — same
// credentials as jira-listener/fetch-ticket.js, read from the same .env.
// Auto-fetching is skipped entirely (with a warning, not an error) when
// these aren't set, so ingest.js keeps working without Jira configured.
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_STORY_POINTS_FIELD = process.env.JIRA_STORY_POINTS_FIELD || 'customfield_10016';
// Pepper for the developer_id hash — override in any real deployment.
// This is a POC-appropriate simplification (see docker-compose.yml's
// POSTGRES_PASSWORD / JIRA_WEBHOOK_SECRET for the same pattern), not
// meant to resist a targeted attacker — it exists so that dashboards
// querying raw_spans/session_rollups/ticket_rollup directly see an
// opaque id instead of a plain git email. See db/01_schema.sql's
// `developers` table comment for the full rationale.
const DEVELOPER_ID_SALT = process.env.DEVFINOPS_ID_SALT || 'devfinops-poc-default-salt-change-me';

// Attribute key names as they appear in Claude Code's OTLP output.
// See the note above — verify these against real landed data.
const ATTR = {
  issueKey: 'jira.issue_key',
  sessionId: 'session.id',
  // Set by cli-wrapper/devfinops-claude.js as a resource attribute. Takes
  // priority over Claude Code's own session.id (below) when present,
  // because it's the same id the git hooks stamp onto commit trailers —
  // see the ATTR.wrapperSessionId comment in resolveSessionId().
  wrapperSessionId: 'devfinops.session_id',
  developerId: 'developer.id',
  developerEmail: 'developer.email', // only present when developer.id resolved from a real email, not a git user.name fallback
  promptId: 'prompt.id',
  toolName: 'tool_name',
  toolParameters: 'tool_parameters', // JSON-encoded string; contains full_command for Bash
  eventName: 'event.name',
  decision: 'decision',
  success: 'success',
  costUsd: 'cost_usd',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
};

const pool = new Pool({ connectionString: DATABASE_URL });

// ---- OTLP attribute helpers ---------------------------------------------

function attrListToMap(attrList) {
  const out = {};
  for (const kv of attrList || []) {
    const v = kv.value || {};
    out[kv.key] =
      v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? v.arrayValue ?? null;
  }
  return out;
}

function nanosToDate(nanos) {
  if (!nanos) return null;
  // OTLP JSON timestamps are strings of nanoseconds-since-epoch.
  const ms = Number(BigInt(nanos) / 1000000n);
  return new Date(ms).toISOString();
}

function extractFullCommand(attrs) {
  // tool_parameters arrives as a JSON-encoded string (not a nested object)
  // in Claude Code's OTLP output. Only Bash tool_result events carry a
  // full_command field inside it; other tools have a differently-shaped
  // tool_parameters payload, so a parse failure here is expected and safe
  // to swallow, not a bug.
  const raw = attrs[ATTR.toolParameters];
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed.full_command || parsed.bash_command || null;
  } catch (e) {
    return null;
  }
}

function resolveSessionId(localAttrs, resourceAttrs) {
  // devfinops.session_id is minted by the wrapper before `claude` is
  // spawned and is guaranteed to match what the git hooks stamped onto
  // any commit made during the session (see cli-wrapper/devfinops-claude.js
  // and cli-wrapper/git-hooks/post-commit) — prefer it over Claude Code's
  // own session.id so the raw_spans/raw_events/session_rollups.session_id
  // a git_commits row joins against is the same id, reliably. Sessions
  // launched without the wrapper (no devfinops.session_id resource
  // attribute) fall back to Claude Code's own span/resource session.id,
  // unchanged from before this id existed.
  return (
    resourceAttrs[ATTR.wrapperSessionId] ||
    localAttrs[ATTR.sessionId] ||
    resourceAttrs[ATTR.sessionId] ||
    null
  );
}

function hashDeveloperId(rawId) {
  if (!rawId || rawId === 'UNATTRIBUTED') return 'UNATTRIBUTED';
  return crypto
    .createHash('sha256')
    .update(`${DEVELOPER_ID_SALT}:${rawId}`)
    .digest('hex')
    .slice(0, 16);
}

// Records the (pseudonymous id -> real identity) mapping exactly once,
// in the one table dashboards aren't granted access to (see
// db/05_access_control.sql) — everywhere else in the schema only ever
// sees the hash. No-ops for UNATTRIBUTED sessions.
async function upsertDeveloper(client, rawId, email) {
  if (!rawId || rawId === 'UNATTRIBUTED') return;
  await client.query(
    `INSERT INTO developers (developer_id, git_email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (developer_id) DO NOTHING`,
    [hashDeveloperId(rawId), email || null, email ? null : rawId]
  );
}

function classifySpan(spanName, attrs) {
  const name = (spanName || '').toLowerCase();
  if (name.includes('interaction')) return 'interaction';
  if (name.includes('tool')) return 'tool';
  if (name.includes('llm_request') || name.includes('api_request')) return 'llm_request';
  return 'other';
}

// ---- Incremental file reading ----------------------------------------------

async function getCursor(client, fileName) {
  const { rows } = await client.query(
    'SELECT file_inode, byte_offset FROM ingest_cursors WHERE file_name = $1',
    [fileName]
  );
  if (rows.length === 0) return { inode: null, offset: 0 };
  return {
    inode: rows[0].file_inode == null ? null : Number(rows[0].file_inode),
    offset: Number(rows[0].byte_offset),
  };
}

async function upsertCursor(client, fileName, inode, offset) {
  await client.query(
    `INSERT INTO ingest_cursors (file_name, file_inode, byte_offset, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (file_name) DO UPDATE SET
       file_inode  = EXCLUDED.file_inode,
       byte_offset = EXCLUDED.byte_offset,
       updated_at  = now()`,
    [fileName, inode, offset]
  );
}

// Reads only what's new since `cursor`, bounded to a single stat()
// snapshot of the file so we're never racing whatever's actively
// appending to it. Returns whole, newline-terminated lines only — if
// the file's last line at snapshot time has no trailing newline yet
// (a write still in progress), it's held back rather than parsed, and
// the returned offset stops right before it. Next run picks it up once
// it's actually complete. Detects rotation via inode, not offset-vs-size
// — see the ingest_cursors table comment in db/01_schema.sql for why
// that distinction matters.
async function readNewLines(filePath, cursor) {
  const stats = fs.statSync(filePath);
  const inode = stats.ino;
  const currentSize = stats.size;

  let offset = cursor.offset;
  const rotated = cursor.inode != null && cursor.inode !== inode;
  if (rotated) {
    console.warn(
      `[ingest] ${path.basename(filePath)} rotated (inode changed) — resuming from the ` +
        `start of the new file. Anything left unread in the previous file before rotation ` +
        `is not recovered by this run; see the README's ingest-frequency guidance.`
    );
    offset = 0;
  }

  if (offset >= currentSize) {
    // Nothing new. offset > currentSize shouldn't happen once rotation
    // is handled above, but clamp defensively rather than reading with
    // a negative range if it ever does.
    return { lines: [], newOffset: Math.min(offset, currentSize), inode };
  }

  const rangeSize = currentSize - offset;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { start: offset, end: currentSize - 1 }),
  });

  const lines = [];
  let consumedBytes = 0;
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline
    if (consumedBytes + lineBytes > rangeSize) {
      // This line's bytes run past what we confirmed is on disk with a
      // trailing newline — it's an in-progress write, not corrupt data.
      // Stop here; don't consume or count it.
      break;
    }
    lines.push(line);
    consumedBytes += lineBytes;
  }

  return { lines, newOffset: offset + consumedBytes, inode };
}

// ---- Trace parsing --------------------------------------------------------

async function ingestTraces(filePath, client) {
  const fileName = path.resolve(filePath); // full path, not basename — avoids collisions across different LANDING_ZONE_DIR values
  if (!fs.existsSync(filePath)) {
    console.warn(`[ingest] no traces file at ${filePath}, skipping`);
    return { spans: 0 };
  }

  const cursor = await getCursor(client, fileName);
  const { lines, newOffset, inode } = await readNewLines(filePath, cursor);
  if (lines.length === 0) {
    if (cursor.inode !== inode) await upsertCursor(client, fileName, inode, newOffset);
    return { spans: 0 };
  }

  let spanCount = 0;
  await client.query('BEGIN');
  try {
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (e) {
        console.warn(`[ingest] skipping malformed trace line: ${e.message}`);
        continue;
      }

      for (const rs of payload.resourceSpans || []) {
        const resourceAttrs = attrListToMap(rs.resource?.attributes);
        const issueKey = resourceAttrs[ATTR.issueKey] || 'UNATTRIBUTED';
        const rawDeveloperId = resourceAttrs[ATTR.developerId] || 'UNATTRIBUTED';
        const developerId = hashDeveloperId(rawDeveloperId);
        await upsertDeveloper(client, rawDeveloperId, resourceAttrs[ATTR.developerEmail]);

        for (const ss of rs.scopeSpans || []) {
          for (const span of ss.spans || []) {
            const spanAttrs = attrListToMap(span.attributes);
            const sessionId = resolveSessionId(spanAttrs, resourceAttrs);
            const promptId = spanAttrs[ATTR.promptId] || null;
            const spanKind = classifySpan(span.name, spanAttrs);
            const startTs = nanosToDate(span.startTimeUnixNano);
            const endTs = nanosToDate(span.endTimeUnixNano);

            if (!startTs || !endTs) continue; // guard against malformed spans

            await client.query(
              `INSERT INTO raw_spans (
                 span_id, parent_span_id, trace_id, session_id, prompt_id,
                 issue_key, developer_id, span_name, span_kind, tool_name,
                 start_ts, end_ts, cost_usd, input_tokens, output_tokens,
                 raw_payload
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT (span_id) DO NOTHING`,
              [
                span.spanId,
                span.parentSpanId || null,
                span.traceId,
                sessionId,
                promptId,
                issueKey,
                developerId,
                span.name,
                spanKind,
                spanAttrs[ATTR.toolName] || null,
                startTs,
                endTs,
                Number(spanAttrs[ATTR.costUsd] || 0),
                Number(spanAttrs[ATTR.inputTokens] || 0),
                Number(spanAttrs[ATTR.outputTokens] || 0),
                span,
              ]
            );
            spanCount += 1;
          }
        }
      }
    }

    await upsertCursor(client, fileName, inode, newOffset);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { spans: spanCount };
}

// ---- Log/event parsing -----------------------------------------------------

async function ingestLogs(filePath, client) {
  const fileName = path.resolve(filePath); // full path, not basename — avoids collisions across different LANDING_ZONE_DIR values
  if (!fs.existsSync(filePath)) {
    console.warn(`[ingest] no logs file at ${filePath}, skipping`);
    return { events: 0 };
  }

  const cursor = await getCursor(client, fileName);
  const { lines, newOffset, inode } = await readNewLines(filePath, cursor);
  if (lines.length === 0) {
    if (cursor.inode !== inode) await upsertCursor(client, fileName, inode, newOffset);
    return { events: 0 };
  }

  let eventCount = 0;
  await client.query('BEGIN');
  try {
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (e) {
        console.warn(`[ingest] skipping malformed log line: ${e.message}`);
        continue;
      }

      for (const rl2 of payload.resourceLogs || []) {
        const resourceAttrs = attrListToMap(rl2.resource?.attributes);
        const issueKey = resourceAttrs[ATTR.issueKey] || 'UNATTRIBUTED';
        const rawDeveloperId = resourceAttrs[ATTR.developerId] || 'UNATTRIBUTED';
        const developerId = hashDeveloperId(rawDeveloperId);
        await upsertDeveloper(client, rawDeveloperId, resourceAttrs[ATTR.developerEmail]);

        for (const sl of rl2.scopeLogs || []) {
          for (const record of sl.logRecords || []) {
            const attrs = attrListToMap(record.attributes);
            const eventName = attrs[ATTR.eventName] || record.body?.stringValue || 'unknown';
            const ts = nanosToDate(record.timeUnixNano);
            if (!ts) continue;

            try {
              // A failed statement poisons the rest of an open Postgres
              // transaction (every later query errors with "current
              // transaction is aborted" until a ROLLBACK) — since this
              // insert now runs inside the whole file's transaction
              // instead of auto-committing on its own, a SAVEPOINT is
              // what keeps one bad event from silently discarding every
              // good event after it in the same batch, and from
              // permanently wedging the offset on retry.
              await client.query('SAVEPOINT event_insert');
              await client.query(
                `INSERT INTO raw_events (
                   session_id, prompt_id, issue_key, developer_id, event_name,
                   ts, tool_name, full_command, decision, success, cost_usd,
                   input_tokens, output_tokens, raw_payload
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT (session_id, event_name, ts, (COALESCE(tool_name, ''))) DO NOTHING`,
                [
                  resolveSessionId(attrs, resourceAttrs),
                  attrs[ATTR.promptId] || null,
                  issueKey,
                  developerId,
                  eventName,
                  ts,
                  attrs[ATTR.toolName] || null,
                  extractFullCommand(attrs),
                  attrs[ATTR.decision] || null,
                  attrs[ATTR.success] === true || attrs[ATTR.success] === 'true',
                  Number(attrs[ATTR.costUsd] || 0),
                  Number(attrs[ATTR.inputTokens] || 0),
                  Number(attrs[ATTR.outputTokens] || 0),
                  record,
                ]
              );
              await client.query('RELEASE SAVEPOINT event_insert');
              eventCount += 1;
            } catch (e) {
              await client.query('ROLLBACK TO SAVEPOINT event_insert');
              console.warn(`[ingest] failed to insert event: ${e.message}`);
            }
          }
        }
      }
    }

    await upsertCursor(client, fileName, inode, newOffset);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { events: eventCount };
}

// ---- Git commit correlation ------------------------------------------------

async function ingestGitCommits(filePath, client) {
  const fileName = path.resolve(filePath); // full path, not basename — avoids collisions across different LANDING_ZONE_DIR values
  if (!fs.existsSync(filePath)) {
    console.warn(`[ingest] no git_commits file at ${filePath}, skipping`);
    return { commits: 0 };
  }

  const cursor = await getCursor(client, fileName);
  const { lines, newOffset, inode } = await readNewLines(filePath, cursor);
  if (lines.length === 0) {
    if (cursor.inode !== inode) await upsertCursor(client, fileName, inode, newOffset);
    return { commits: 0 };
  }

  let commitCount = 0;
  await client.query('BEGIN');
  try {
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (e) {
        console.warn(`[ingest] skipping malformed git_commits line: ${e.message}`);
        continue;
      }

      if (!record.commit_sha) continue;

      // record.developer_email is the git commit author email (git log
      // %ae) — plain, since it's read from a local JSONL file, not a
      // dashboard-facing table. Hash it the same way as everywhere else
      // before it touches git_commits, and record the mapping. In the
      // common case this is the same address as `git config user.email`,
      // so it hashes to the same developer_id the session was tagged
      // with — letting commits join to session_rollups by developer, not
      // just by session_id.
      const rawDeveloperId = record.developer_email || 'UNATTRIBUTED';
      await upsertDeveloper(client, rawDeveloperId, record.developer_email);

      await client.query(
        `INSERT INTO git_commits (
           commit_sha, session_id, issue_key, developer_id, subject,
           files_changed, insertions, deletions, committed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (commit_sha) DO UPDATE SET
           session_id    = EXCLUDED.session_id,
           issue_key     = EXCLUDED.issue_key,
           developer_id  = EXCLUDED.developer_id,
           subject       = EXCLUDED.subject,
           files_changed = EXCLUDED.files_changed,
           insertions    = EXCLUDED.insertions,
           deletions     = EXCLUDED.deletions,
           committed_at  = EXCLUDED.committed_at`,
        [
          record.commit_sha,
          record.session_id || null,
          record.issue_key || null,
          hashDeveloperId(rawDeveloperId),
          record.subject || null,
          Number(record.files_changed || 0),
          Number(record.insertions || 0),
          Number(record.deletions || 0),
          record.committed_at || null,
        ]
      );
      commitCount += 1;
    }

    await upsertCursor(client, fileName, inode, newOffset);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { commits: commitCount };
}

// ---- Jira reconciliation ---------------------------------------------------
//
// Sessions and commits can reference an issue_key that jira_issues has
// never seen (jira-listener.js only hears about a ticket if a webhook
// fires for it; fetch-ticket.js only knows about keys someone fetched by
// hand). Rather than requiring a manual fetch-ticket.js run for every
// new key, pull the missing ones automatically here, once per ingest
// run — same REST API v3 call and field extraction as fetch-ticket.js,
// duplicated rather than shared, matching how this repo doesn't share
// code across service directories anywhere else either.

function extractStoryPoints(fields, issueKey) {
  const raw = fields[JIRA_STORY_POINTS_FIELD];
  if (typeof raw === 'number') return raw;
  if (raw != null) {
    console.warn(
      `[ingest] ${JIRA_STORY_POINTS_FIELD} on ${issueKey} isn't numeric (${JSON.stringify(raw)}) — ` +
        `storing null. Set JIRA_STORY_POINTS_FIELD if your instance uses a different custom field id.`
    );
  }
  return null;
}

async function fetchJiraIssue(issueKey) {
  const url = `${JIRA_HOST.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const auth = Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jira rejected the credentials (HTTP ${res.status}) — check JIRA_USER_EMAIL / JIRA_API_TOKEN in .env`);
  }
  if (res.status === 404) {
    throw new Error(`not found at ${JIRA_HOST} (HTTP 404) — is ${issueKey} a real key on this workspace?`);
  }
  if (!res.ok) {
    throw new Error(`Jira API request failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function reconcileMissingJiraIssues(client) {
  // Issue keys with a real session, event, or commit but no jira_issues
  // row yet — not scoped to just this run's landing-zone files, so this
  // also backfills any gap left over from before auto-fetch existed.
  const { rows } = await client.query(`
    SELECT DISTINCT seen.issue_key
    FROM (
      SELECT issue_key FROM raw_spans   WHERE issue_key IS NOT NULL AND issue_key <> 'UNATTRIBUTED'
      UNION
      SELECT issue_key FROM raw_events  WHERE issue_key IS NOT NULL AND issue_key <> 'UNATTRIBUTED'
      UNION
      SELECT issue_key FROM git_commits WHERE issue_key IS NOT NULL AND issue_key <> 'UNATTRIBUTED'
    ) seen
    WHERE NOT EXISTS (SELECT 1 FROM jira_issues ji WHERE ji.issue_key = seen.issue_key)
  `);

  if (rows.length === 0) return { fetched: 0, failed: 0 };

  if (!JIRA_HOST || !JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
    console.warn(
      `[ingest] ${rows.length} issue key(s) have no jira_issues row yet ` +
        `(${rows.map((r) => r.issue_key).join(', ')}) — JIRA_HOST/JIRA_USER_EMAIL/JIRA_API_TOKEN ` +
        `aren't set in .env, skipping automatic fetch. See README's Jira setup guide.`
    );
    return { fetched: 0, failed: 0 };
  }

  let fetched = 0;
  let failed = 0;
  for (const { issue_key: issueKey } of rows) {
    try {
      const issue = await fetchJiraIssue(issueKey);
      const fields = issue.fields || {};
      await client.query(
        `INSERT INTO jira_issues (issue_key, summary, status, story_points, issue_type, assignee_email, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (issue_key) DO UPDATE SET
           summary        = EXCLUDED.summary,
           status         = EXCLUDED.status,
           story_points   = EXCLUDED.story_points,
           issue_type     = EXCLUDED.issue_type,
           assignee_email = EXCLUDED.assignee_email,
           updated_at     = now()`,
        [
          issue.key,
          fields.summary || null,
          fields.status?.name || null,
          extractStoryPoints(fields, issue.key),
          fields.issuetype?.name || null,
          fields.assignee?.emailAddress || null,
        ]
      );
      console.log(`[ingest] auto-fetched ${issue.key} from Jira and upserted into jira_issues`);
      fetched += 1;
    } catch (err) {
      // One bad key (typo'd branch name, deleted ticket, ...) shouldn't
      // abort ingestion for everything else — log and move on.
      console.warn(`[ingest] could not auto-fetch ${issueKey} from Jira (continuing): ${err.message}`);
      failed += 1;
    }
  }

  return { fetched, failed };
}

// ---- Main -----------------------------------------------------------------

async function main() {
  const client = await pool.connect();
  try {
    console.log(`[ingest] reading landing zone: ${LANDING_ZONE_DIR}`);

    const tracesResult = await ingestTraces(path.join(LANDING_ZONE_DIR, 'traces.jsonl'), client);
    console.log(`[ingest] loaded ${tracesResult.spans} spans`);

    const logsResult = await ingestLogs(path.join(LANDING_ZONE_DIR, 'logs.jsonl'), client);
    console.log(`[ingest] loaded ${logsResult.events} events`);

    const commitsResult = await ingestGitCommits(path.join(LANDING_ZONE_DIR, 'git_commits.jsonl'), client);
    console.log(`[ingest] loaded ${commitsResult.commits} git commits`);

    const jiraResult = await reconcileMissingJiraIssues(client);
    if (jiraResult.fetched > 0 || jiraResult.failed > 0) {
      console.log(`[ingest] Jira reconciliation: ${jiraResult.fetched} fetched, ${jiraResult.failed} failed`);
    }

    console.log('[ingest] running derivation query (session_rollups)...');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '04_derive_session_rollups.sql'), 'utf8');
    // Strip psql \set meta-commands and substitute the values inline, since
    // the pg driver (unlike psql) can't interpret \set. Keep this in sync
    // with the defaults in db/derive_session_rollups.sql if you change them.
    const executable = sql
      .replace(/\\set\s+\w+\s+\d+/g, '')
      .replace(/:ceiling_seconds/g, '900')
      .replace(/:floor_seconds/g, '60');
    await client.query(executable);

    console.log('[ingest] done.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ingest] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { attrListToMap, nanosToDate, classifySpan };
