#!/usr/bin/env node
'use strict';

/**
 * ingest.js
 *
 * Reads the OTel Collector's JSONL landing-zone files (traces.jsonl,
 * logs.jsonl) and loads them into Postgres (raw_spans, raw_events).
 *
 * This is a batch/replayable ingestion for the POC — run it after a test
 * session, or on a loop/cron in a slightly more built-out version. It's
 * idempotent: re-running it against the same files won't create duplicate
 * rows (spans are keyed by span_id; events are de-duped via the unique
 * constraint on raw_events).
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
const { Pool } = require('pg');

const LANDING_ZONE_DIR = process.env.LANDING_ZONE_DIR || './landing_zone';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://devfinops:devfinops@localhost:5432/devfinops';

// Attribute key names as they appear in Claude Code's OTLP output.
// See the note above — verify these against real landed data.
const ATTR = {
  issueKey: 'jira.issue_key',
  sessionId: 'session.id',
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

function classifySpan(spanName, attrs) {
  const name = (spanName || '').toLowerCase();
  if (name.includes('interaction')) return 'interaction';
  if (name.includes('tool')) return 'tool';
  if (name.includes('llm_request') || name.includes('api_request')) return 'llm_request';
  return 'other';
}

// ---- Trace parsing --------------------------------------------------------

async function ingestTraces(filePath, client) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[ingest] no traces file at ${filePath}, skipping`);
    return { spans: 0 };
  }

  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let spanCount = 0;

  for await (const line of rl) {
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

      for (const ss of rs.scopeSpans || []) {
        for (const span of ss.spans || []) {
          const spanAttrs = attrListToMap(span.attributes);
          const sessionId = spanAttrs[ATTR.sessionId] || resourceAttrs[ATTR.sessionId] || null;
          const promptId = spanAttrs[ATTR.promptId] || null;
          const spanKind = classifySpan(span.name, spanAttrs);
          const startTs = nanosToDate(span.startTimeUnixNano);
          const endTs = nanosToDate(span.endTimeUnixNano);

          if (!startTs || !endTs) continue; // guard against malformed spans

          await client.query(
            `INSERT INTO raw_spans (
               span_id, parent_span_id, trace_id, session_id, prompt_id,
               issue_key, span_name, span_kind, tool_name, start_ts, end_ts,
               cost_usd, input_tokens, output_tokens, raw_payload
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (span_id) DO NOTHING`,
            [
              span.spanId,
              span.parentSpanId || null,
              span.traceId,
              sessionId,
              promptId,
              issueKey,
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

  return { spans: spanCount };
}

// ---- Log/event parsing -----------------------------------------------------

async function ingestLogs(filePath, client) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[ingest] no logs file at ${filePath}, skipping`);
    return { events: 0 };
  }

  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let eventCount = 0;

  for await (const line of rl) {
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

      for (const sl of rl2.scopeLogs || []) {
        for (const record of sl.logRecords || []) {
          const attrs = attrListToMap(record.attributes);
          const eventName = attrs[ATTR.eventName] || record.body?.stringValue || 'unknown';
          const ts = nanosToDate(record.timeUnixNano);
          if (!ts) continue;

          try {
            await client.query(
              `INSERT INTO raw_events (
                 session_id, prompt_id, issue_key, event_name, ts, tool_name,
                 full_command, decision, success, cost_usd, input_tokens,
                 output_tokens, raw_payload
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (session_id, event_name, ts, tool_name) DO NOTHING`,
              [
                attrs[ATTR.sessionId] || null,
                attrs[ATTR.promptId] || null,
                issueKey,
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
            eventCount += 1;
          } catch (e) {
            console.warn(`[ingest] failed to insert event: ${e.message}`);
          }
        }
      }
    }
  }

  return { events: eventCount };
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
