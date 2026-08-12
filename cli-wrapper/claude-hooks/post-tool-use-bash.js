#!/usr/bin/env node
'use strict';

/**
 * post-tool-use-bash.js — Claude Code PostToolUse hook, matched to Bash only
 * (see the "matcher": "Bash" scoping in buildHooksSettings() in
 * devfinops-claude.js).
 *
 * Classifies the command into a coarse category and discards the command
 * text — same posture as user-prompt-submit.js. This is deliberately NOT
 * trying to replace db/03_hygiene_and_guardrails.sql's test_run_events/
 * commit_events views, which match full_command text that real Claude
 * Code telemetry doesn't actually carry (confirmed by inspecting a real
 * tool_result payload — see the signal-boundary memo). This hook sees the
 * command locally, before that scrubbing ever happens, which is exactly
 * why it can do the classification those SQL views can't.
 *
 * Real stdin shape for PostToolUse (Claude Code CLI, verified against a
 * real session, not assumed from docs):
 *   { session_id, transcript_path, cwd, prompt_id, permission_mode,
 *     hook_event_name, tool_name, tool_input: { command, description },
 *     tool_response: { stdout, stderr, ... }, tool_use_id, duration_ms }
 * (tool_input.command, and "tool_response" not "tool_result" — both
 * corrections to what the installed plugin-dev hook docs claimed.)
 */

const fs = require('fs');
const path = require('path');

// Reuses the same test-runner pattern family as
// db/03_hygiene_and_guardrails.sql's test_run_events view, for
// consistency between the two signals even though they're computed by
// completely different mechanisms (SQL over telemetry vs. a local hook).
const CATEGORY_RULES = [
  ['test', /\b(pytest|npm test|npm run test|yarn test|go test|jest|mvn test|cargo test|rspec|phpunit)\b/i],
  ['build', /\b(npm run build|yarn build|make\b|docker build|webpack|tsc\b|cargo build|mvn (package|install|compile)|go build)\b/i],
  ['git', /^\s*git\s+/i],
];

function classifyCommand(command) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(command)) return category;
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
    return;
  }

  if (input.tool_name !== 'Bash') return;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || command.length === 0) return;

  // The command exists only in this local variable, in this local
  // process. Nothing below this line touches it again.
  const signal = {
    session_id: process.env.DEVFINOPS_SESSION_ID || input.session_id || null,
    issue_key: process.env.DEVFINOPS_ISSUE_KEY || null,
    developer_email: process.env.DEVFINOPS_DEVELOPER_ID || null,
    category: classifyCommand(command),
    ts: new Date().toISOString(),
  };

  const landingZoneDir = process.env.DEVFINOPS_LANDING_ZONE_DIR || './landing_zone';
  fs.mkdirSync(landingZoneDir, { recursive: true });
  fs.appendFileSync(path.join(landingZoneDir, 'tool_signals.jsonl'), JSON.stringify(signal) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`[devfinops] post-tool-use-bash hook failed (ignored): ${err.message}\n`);
}

process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
