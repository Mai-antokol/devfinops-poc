#!/usr/bin/env node
'use strict';

/**
 * devfinops-claude
 *
 * Thin wrapper around the real `claude` CLI. Resolves a Jira issue key for
 * the current work (from --issue or the current git branch), injects it
 * plus the required OTel env vars, then execs the real `claude` binary
 * with those vars in place. Every OTel signal emitted by the wrapped
 * session will carry `jira.issue_key` as a resource attribute.
 *
 * Usage:
 *   devfinops-claude --issue PROJ-101 -p "refactor the auth module"
 *   devfinops-claude                       # resolves issue key from git branch
 */

const { spawn, execSync } = require('child_process');

// ---- Config -----------------------------------------------------------

const CONFIG = {
  // Name of the real Claude Code binary on PATH. Must differ from this
  // wrapper's own binary name to avoid alias recursion.
  realBinary: process.env.DEVFINOPS_CLAUDE_BIN || 'claude',
  otlpEndpoint: process.env.DEVFINOPS_OTLP_ENDPOINT || 'http://localhost:4317',
  // Matches PROJ-101, ABC-42, etc. Adjust if your Jira project keys use
  // lowercase or a different shape.
  issueKeyPattern: /([A-Z][A-Z0-9]{1,9}-\d+)/,
  fallbackIssueKey: 'UNATTRIBUTED',
};

// ---- Issue key resolution ----------------------------------------------

function resolveIssueKeyFromArgs(argv) {
  const idx = argv.indexOf('--issue');
  if (idx !== -1 && argv[idx + 1]) {
    return { issueKey: argv[idx + 1], consumedIndices: [idx, idx + 1] };
  }
  return { issueKey: null, consumedIndices: [] };
}

function resolveIssueKeyFromGitBranch() {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = branch.match(CONFIG.issueKeyPattern);
    return match ? match[1] : null;
  } catch (err) {
    // Not a git repo, git not installed, or detached HEAD — not fatal,
    // we just fall through to the fallback key.
    return null;
  }
}

function resolveIssueKey(argv) {
  const { issueKey: fromFlag, consumedIndices } = resolveIssueKeyFromArgs(argv);
  if (fromFlag) {
    return { issueKey: fromFlag, source: 'flag', consumedIndices };
  }

  const fromBranch = resolveIssueKeyFromGitBranch();
  if (fromBranch) {
    return { issueKey: fromBranch, source: 'git-branch', consumedIndices: [] };
  }

  return { issueKey: CONFIG.fallbackIssueKey, source: 'fallback', consumedIndices: [] };
}

// ---- Env var construction ----------------------------------------------

function buildEnv(issueKey) {
  // Preserve any resource attributes the developer or managed-settings.json
  // already set, and append ours rather than clobbering them.
  const existingAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  const ourAttrs = `jira.issue_key=${issueKey},session.origin=cli`;
  const mergedAttrs = existingAttrs ? `${existingAttrs},${ourAttrs}` : ourAttrs;

  return {
    ...process.env,
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: CONFIG.otlpEndpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    OTEL_RESOURCE_ATTRIBUTES: mergedAttrs,
  };
}

// ---- Main ----------------------------------------------------------------

function main() {
  const rawArgs = process.argv.slice(2);
  const { issueKey, source, consumedIndices } = resolveIssueKey(rawArgs);

  // Strip --issue <value> from the args we forward to the real claude binary.
  const forwardedArgs = rawArgs.filter((_, i) => !consumedIndices.includes(i));

  if (source === 'fallback') {
    process.stderr.write(
      `[devfinops-claude] warning: could not resolve a Jira issue key ` +
        `(no --issue flag, no PROJ-123-style git branch). Tagging session as ` +
        `"${CONFIG.fallbackIssueKey}" — this session's cost will show up as ` +
        `unattributed spend.\n`
    );
  } else {
    process.stderr.write(
      `[devfinops-claude] tagging session with jira.issue_key=${issueKey} (source: ${source})\n`
    );
  }

  const env = buildEnv(issueKey);

  const child = spawn(CONFIG.realBinary, forwardedArgs, {
    stdio: 'inherit',
    env,
  });

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        `[devfinops-claude] error: could not find "${CONFIG.realBinary}" on PATH. ` +
          `Is Claude Code installed? (set DEVFINOPS_CLAUDE_BIN if it's named differently)\n`
      );
      process.exit(127);
    }
    throw err;
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code === null ? 1 : code);
    }
  });
}

main();
