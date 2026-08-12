#!/usr/bin/env node
'use strict';

/**
 * user-prompt-submit.js — Claude Code UserPromptSubmit hook.
 *
 * Wired in by devfinops-claude.js via `--settings` (see buildHooksSettings()
 * in that file), not installed per-repo the way the git hooks are — every
 * session launched through the wrapper gets this automatically.
 *
 * Reads the real prompt text from stdin (field name and shape verified
 * empirically against a real session, not assumed from docs — see the
 * commit that added this file), derives a small structured signal, and
 * discards the text. The raw prompt is never written to disk, never
 * logged, never included in the hook's own output — it exists only in
 * this process's memory for the few milliseconds it takes to run three
 * regexes against it.
 *
 * Real stdin shape for UserPromptSubmit (Claude Code CLI, verified):
 *   { session_id, transcript_path, cwd, prompt_id, permission_mode,
 *     hook_event_name, prompt }
 * ("prompt", not "user_prompt" — the installed plugin-dev hook docs on
 * this machine had that field name wrong; don't trust it without
 * re-checking against a real session if the CLI version changes.)
 */

const fs = require('fs');
const path = require('path');

// Ordered by priority — a prompt can match multiple categories (e.g.
// "fix the failing test"), so the first match wins. bug_fix outranks
// test deliberately: "fix" is a stronger, more specific signal than the
// mere presence of the word "test".
const INTENT_RULES = [
  ['bug_fix', /\b(fix|bug|broken|crash(ed|es|ing)?|error|fail(s|ed|ing)?|regression)\b/i],
  ['test', /\b(test|tests|testing|spec|coverage)\b/i],
  ['refactor', /\b(refactor|clean ?up|simplify|reorgani[sz]e|restructure)\b/i],
  ['feature', /\b(add|implement|create|build|support for|new feature)\b/i],
];

function classifyIntent(prompt) {
  for (const [intent, pattern] of INTENT_RULES) {
    if (pattern.test(prompt)) return intent;
  }
  return 'other';
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

function main() {
  const raw = readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    return; // malformed input — nothing safe to do, just no-op
  }

  const prompt = input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return;

  // Everything derived here happens before `prompt` goes out of scope.
  // Nothing below this line ever holds the raw text again.
  const signal = {
    session_id: process.env.DEVFINOPS_SESSION_ID || input.session_id || null,
    issue_key: process.env.DEVFINOPS_ISSUE_KEY || null,
    developer_email: process.env.DEVFINOPS_DEVELOPER_ID || null,
    intent: classifyIntent(prompt),
    mentions_tests: /\b(test|tests|testing|spec)\b/i.test(prompt),
    prompt_length: prompt.length,
    ts: new Date().toISOString(),
  };

  const landingZoneDir = process.env.DEVFINOPS_LANDING_ZONE_DIR || './landing_zone';
  fs.mkdirSync(landingZoneDir, { recursive: true });
  fs.appendFileSync(path.join(landingZoneDir, 'prompt_signals.jsonl'), JSON.stringify(signal) + '\n');
}

try {
  main();
} catch (err) {
  // Never block the session over a telemetry hook — same principle as
  // the git hooks.
  process.stderr.write(`[devfinops] user-prompt-submit hook failed (ignored): ${err.message}\n`);
}

// Quiet, non-blocking response — verified this exact shape is accepted
// by a real session ("Successfully parsed and validated hook JSON
// output" in --debug-file output).
process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
