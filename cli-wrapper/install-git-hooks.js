#!/usr/bin/env node
'use strict';

/**
 * install-git-hooks.js
 *
 * git never auto-installs hooks from a repo's tracked files — they have to
 * be copied into .git/hooks manually. This copies the devfinops
 * prepare-commit-msg / post-commit hooks (git-hooks/) into the target
 * repo's .git/hooks/, so that commits made during a devfinops-claude
 * session get stamped with Session-Id/Jira-Issue trailers and recorded
 * into git_commits.jsonl.
 *
 * Run this once per repo where you do ticketed work (NOT necessarily the
 * devfinops-poc repo itself):
 *
 *   node /path/to/devfinops-poc/cli-wrapper/install-git-hooks.js [target-repo]
 *
 * target-repo defaults to the current directory. Refuses to overwrite a
 * hook it didn't install (no "devfinops-installed" marker) — prints
 * instructions to chain it manually instead.
 */

const fs = require('fs');
const path = require('path');

const MARKER = 'devfinops-installed';
const HOOKS = ['prepare-commit-msg', 'post-commit'];
const SOURCE_DIR = path.join(__dirname, 'git-hooks');

function main() {
  const targetRepo = path.resolve(process.argv[2] || '.');
  const gitDir = path.join(targetRepo, '.git');

  if (!fs.existsSync(gitDir)) {
    console.error(`[install-git-hooks] no .git found at ${targetRepo} — is this a git repo root?`);
    process.exit(1);
  }

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  for (const hook of HOOKS) {
    const src = path.join(SOURCE_DIR, hook);
    const dest = path.join(hooksDir, hook);
    const source = fs.readFileSync(src, 'utf8');

    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest, 'utf8');
      if (existing.includes(MARKER)) {
        fs.writeFileSync(dest, source, { mode: 0o755 });
        console.log(`[install-git-hooks] updated ${hook}`);
        continue;
      }
      console.warn(
        `[install-git-hooks] ${hook} already exists at ${dest} and wasn't installed by ` +
          `devfinops — leaving it alone. To use both, call ` +
          `"${src}" from the end of your existing ${hook} hook, forwarding its arguments.`
      );
      continue;
    }

    fs.writeFileSync(dest, source, { mode: 0o755 });
    console.log(`[install-git-hooks] installed ${hook} -> ${dest}`);
  }
}

main();
