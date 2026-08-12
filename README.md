# DevFinOps POC

Attributes the real cost of Claude Code usage — active developer time plus
token spend — to individual Jira tickets, so you can answer "what did this
ticket actually cost?" instead of just "how many story points was it."

Pipeline, end to end: a CLI wrapper tags Claude Code sessions with a Jira
issue key and a developer identity → an OTel Collector lands the
telemetry as JSONL → a batch ingestion service loads it into Postgres and
derives per-session active/wait time → a Grafana dashboard reads the
result. A pair of git hooks separately links sessions to the commits they
produced.

## Prerequisites

- Docker and Docker Compose (`docker compose version` — this repo uses
  the `docker compose` CLI plugin, not the standalone `docker-compose`
  binary)
- Node.js >= 18 and npm
- git
- The [Claude Code CLI](https://claude.com/claude-code) itself, installed
  and authenticated — **only** required if you want to actually run
  `devfinops-claude` sessions and generate real telemetry. Everything
  else (the platform, the dashboards, the schema) runs without it.

## Quickstart

```sh
git clone <this-repo-url>
cd devfinops-poc

# Optional — the defaults below work without this step. Create a .env
# if you want to change a password (see .env.example for what's read).
cp .env.example .env

# The one command that brings the platform up: Postgres, the OTel
# Collector, the Jira webhook listener, and Grafana. Postgres runs
# db/*.sql on its first boot only, which is what creates the schema.
docker compose up -d
```

That's the platform. Two more steps make it do something:

```sh
# Loads any landed telemetry (landing_zone/*.jsonl) into Postgres and
# recomputes the per-session active/wait-time rollups. Safe to re-run —
# it's idempotent. On a fresh clone there's no telemetry yet, so this
# will report 0 spans / 0 events / 0 commits the first time, which is
# expected, not an error.
cd ingestion-service
npm install
npm run ingest
cd ..

# Makes `devfinops-claude` available on PATH, wrapping the real `claude`
# binary with Jira/developer/session tagging. Needs the real Claude Code
# CLI installed separately (see Prerequisites).
cd cli-wrapper
npm install
npm link
cd ..
```

## Verifying it's running

```sh
docker compose ps                       # all four containers should be Up (postgres "healthy")
curl -s localhost:4000/healthz          # jira-listener -> {"ok":true}
open http://localhost:3000              # Grafana — admin / devfinops (or your GF_SECURITY_ADMIN_PASSWORD)
```

The Grafana dashboard will be empty on a fresh clone — there's no seed
data committed to this repo. It fills in once real `devfinops-claude`
sessions run and `npm run ingest` picks up their telemetry. To confirm
the schema itself came up correctly without waiting for real usage:

```sh
docker exec -it devfinops-postgres psql -U devfinops -d devfinops -c "\dt"
```

You should see `raw_spans`, `raw_events`, `session_rollups`, `jira_issues`,
`developers`, `git_commits`, `rate_config`, and `guardrail_blocks`.

## Using it for real

```sh
devfinops-claude --issue PROJ-101 -p "refactor the auth module"
# or, from a branch named like PROJ-101-refactor-auth:
devfinops-claude -p "refactor the auth module"
```

This tags the session's OTel export with the Jira issue key, a
pseudonymous developer id (from `git config user.email`), and a session
id, then execs the real `claude` binary. Run `npm run ingest` in
`ingestion-service/` afterward (or put it on a cron) to load the
session into Postgres.

To also link commits made during a session back to it (`git_commits`
table — commit trailers + line-change stats), install the git hooks into
whichever repo you're doing ticketed work in — this is separate from the
devfinops-poc repo itself:

```sh
node /path/to/devfinops-poc/cli-wrapper/install-git-hooks.js /path/to/your/repo
```

### Never having to remember `devfinops-claude` at all

Instead of typing the wrapper name, install a PATH-priority shim so
plain `claude` — however it's invoked, including from an IDE extension
or CI, which a shell alias would never catch — transparently resolves
to the wrapper. A shim beats a shell alias because an alias is only
consulted by an interactive shell that sourced its dotfile; an IDE
extension or CI invocation skips it entirely via a plain PATH search
(see `cli-wrapper/shim/claude.template`'s own comment for more). macOS
only for now — the Windows/Intune equivalent is a machine-level `PATH`
policy plus a Win32 app dropping the same idea in as `claude.exe`:

```sh
sudo cli-wrapper/install-path-shim.sh
# open a NEW terminal window — /etc/paths.d changes only apply to new login shells
which claude   # should now print the shim's path, not the real binary's
```

Run without `sudo` and with `--shim-dir`/`--real-claude-bin` pointed
somewhere else first if you want to see what it does before it touches
system PATH config — see the script's own header comment.

## Pulling a real ticket from Jira Cloud

`jira-listener.js` is the webhook-driven path (real-time, needs a Jira
Cloud OAuth/webhook pointed at this service). `fetch-ticket.js` is a
one-shot alternative for testing against a real workspace without
wiring that up: it calls the Jira REST API v3 directly for one issue
and upserts it the same way the webhook does.

```sh
cp .env.example .env   # if you haven't already
# edit .env: JIRA_HOST, JIRA_USER_EMAIL, and a token from
# https://id.atlassian.com/manage-profile/security/api-tokens

cd jira-listener
npm install
node fetch-ticket.js SAM1-11   # use one of your own issue keys
```

Credentials are only ever read from `.env` / `process.env` — never put
a real token in `.env.example`, which is committed. If a ticket's story
points come back `null` and your project actually has them set, your
Jira instance likely uses a different custom field id than the default
(`customfield_10016`) — override it with `JIRA_STORY_POINTS_FIELD`.

Note this only populates `jira_issues` — it won't show up in Grafana's
ticket-economics panel until a session (real or via `ingest.js`) exists
for the same issue key, since that panel is driven by `session_rollups`
with Jira data joined in for context, not the other way around.

**You shouldn't need to run this by hand for routine use anymore.**
With the same `.env` credentials in place, `ingest.js` now does this
automatically: every time it runs, it checks for any `issue_key` that
shows up in a session or commit but has no `jira_issues` row yet, and
fetches it — no manual `fetch-ticket.js` invocation required. See
"Automatic Jira ticket fetching" below. `fetch-ticket.js` is still
useful for pulling a specific ticket on demand, ahead of any session
existing for it.

## Connecting a Real Jira Workspace

Two different setups, for two different stages — don't reach for the
second one just because it sounds more "real."

### Dev / pilot (what's implemented in this repo today)

1. Generate an API token at
   [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. `cp .env.example .env` and fill in `JIRA_HOST`, `JIRA_USER_EMAIL`,
   `JIRA_API_TOKEN`.
3. That's the whole setup. From here, ticket metadata takes care of
   itself — see the next section.

**Automatic Jira ticket fetching.** Every `npm run ingest` now checks
Postgres for any `issue_key` referenced by a session or a git commit
that doesn't have a `jira_issues` row yet, and fetches it from the real
Jira REST API v3 on the spot — same call `fetch-ticket.js` makes, same
upsert. One bad key (a typo'd branch name, a deleted ticket) logs a
warning and doesn't stop the rest of ingestion. No credentials set? It
logs which keys are waiting and skips the fetch — ingestion still
completes normally, it just won't have Jira context for those tickets
yet.

```sh
cd ingestion-service
npm run ingest
# [ingest] auto-fetched SAM1-11 from Jira and upserted into jira_issues
```

**Testing the webhook path too** (optional — auto-fetch above already
covers "does this ticket exist in our DB"; the webhook keeps
`summary`/`status`/`story_points` fresh as a ticket changes, without
waiting for the next session). Two things you need that a personal dev
setup doesn't have by default:

- **A publicly reachable URL** — Jira Cloud can't reach `localhost:4000`
  directly. Point a tunnel (`ngrok http 4000`, or `cloudflared`) at it
  and use the public URL it gives you.
- **Something in Jira that sends the request.** The admin-only
  *System → Webhooks* screen exists, but doesn't make it easy to attach
  a custom header, which `jira-listener.js` requires
  (`x-devfinops-webhook-secret`). For a dev/pilot workspace, a
  **Jira Automation rule** is the more accessible path: *Project
  Settings → Automation → Create rule* → trigger on *Issue Created* /
  *Issue Updated* → action *Send web request*, pointed at
  `<your-tunnel-url>/webhooks/jira`, with a custom header
  `x-devfinops-webhook-secret: <your JIRA_WEBHOOK_SECRET>`.

### Enterprise production rollout (architecture guidance — not built in this POC)

This is a genuinely different system, not a config change on top of the
dev setup — flagging that plainly rather than implying it's a small
step up:

1. **Register an OAuth 2.0 (3LO) app** at
   [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/),
   with `read:jira-work` and `read:jira-user` scopes.
2. **Org admin does a one-time consent install** — this grants org-wide
   access through a single app identity, not a personal API token per
   developer. Same org-level-over-per-user principle as the two-tier
   deployment memo's Tier 0 recommendation.
3. **Store the resulting access + refresh tokens in a real secret
   store**, not `.env` — this needs actual multi-tenant infrastructure
   behind it (see that same memo's callout that "5 minutes to connect"
   is a true claim about the OAuth consent screen, not about the backend
   it has to land in, which doesn't exist yet in this repo).
4. **Handle token refresh.** Atlassian 3LO access tokens expire in about
   an hour — the integration needs to use the refresh token to get a new
   one automatically, or ingestion silently starts failing auth partway
   through the day.
5. **Register webhooks programmatically**, via `POST /rest/api/3/webhook`
   using the OAuth access token, rather than a human clicking through a
   UI per workspace — scoped to `jira:issue_created` /
   `jira:issue_updated`, pointed at a production `jira-listener` sitting
   behind real TLS with real request verification (Atlassian's webhook
   signing, or requiring the OAuth-authenticated caller) — not the
   shared-secret header this POC uses today.

## Testing & Attribution Guide

How a session ends up tied (or not tied) to a Jira ticket, end to end.

### How a session gets a ticket key

Two ways, both handled entirely by `cli-wrapper/devfinops-claude.js`
before it ever spawns the real `claude` process:

1. **Explicit** — pass `--issue`:
   ```sh
   devfinops-claude --issue PROJ-101 -p "refactor the auth module"
   ```
2. **Implicit, via branch name** — if `--issue` isn't given, the wrapper
   regex-matches your current git branch against `PROJ-101`-shaped keys
   (`([A-Z][A-Z0-9]{1,9}-\d+)`), so `feature/PROJ-101-fix-auth` resolves
   the same as passing `--issue PROJ-101` explicitly. A branch like
   `fix-auth-bug` has no such key in it and won't match.

Either way, the resolved key (or the literal string `UNATTRIBUTED` if
neither resolved anything) is injected into `OTEL_RESOURCE_ATTRIBUTES`
as `jira.issue_key`, and flows through `ingest.js` into every table
that carries `issue_key`. Nothing here calls Jira's API — it's a label
attached at session start, not a live lookup. `jira_issues` (populated
separately by the webhook or `fetch-ticket.js`) only gets joined in
later, for context, when something reads `ticket_rollup`.

### What happens when a session lands `UNATTRIBUTED`

The session isn't lost — it's fully ingested and costed, just with
`issue_key = 'UNATTRIBUTED'`, which is exactly what makes it findable
for follow-up:

```sh
docker exec devfinops-postgres psql -U devfinops -d devfinops -c \
  "SELECT session_id, developer_id, token_cost_usd FROM session_rollups WHERE issue_key = 'UNATTRIBUTED';"
```

Two resolution paths are **designed and schema-ready, not yet
automated** — there is no running job that does this for you today:

- **Single-candidate shortcut**: if `jira_issues.assignee_email` (see
  above) shows exactly one ticket in an active status assigned to that
  session's developer, that's a deterministic match — no inference
  needed, just a query joining `session_rollups.developer_id` through
  `developers.git_email` to `jira_issues.assignee_email`.
- **AI-inferred suggestion queue** (`session_attribution_suggestions`
  table): for the ambiguous remainder, a future backend job would rank
  candidate tickets and write a row per suggestion — `confidence_score`,
  a `rationale` a human can actually read, and `signals_used` (JSONB,
  privacy-safe signals only: tool commands, file paths, commit
  subjects — see the table's own comment on why prompt content isn't in
  there by default).

Nothing in this queue ever touches cost data on its own: an unconfirmed
guess is worse than an honest `UNATTRIBUTED`, since it would silently
corrupt the wrong ticket's cost instead of leaving a visible gap. A
suggestion only becomes real once a human reviews and confirms it,
promoting it into `session_rollups`:

```sql
-- confirm suggestion <uuid>: pin the session to the suggested ticket
UPDATE session_rollups
SET issue_key = (SELECT suggested_issue_key FROM session_attribution_suggestions WHERE suggestion_id = '<uuid>'),
    attribution_source = 'ai_confirmed'
WHERE session_id = (SELECT session_id FROM session_attribution_suggestions WHERE suggestion_id = '<uuid>');

UPDATE session_attribution_suggestions
SET status = 'confirmed', reviewed_at = now()
WHERE suggestion_id = '<uuid>';
```

```sql
-- reject it instead: leave the session UNATTRIBUTED, just close the suggestion
UPDATE session_attribution_suggestions
SET status = 'rejected', reviewed_at = now()
WHERE suggestion_id = '<uuid>';
```

Once confirmed, `attribution_source = 'ai_confirmed'` is pinned —
`db/04_derive_session_rollups.sql`'s full recompute on every `ingest.js`
run will keep refreshing everything else about that session (cost,
active/wait time) but will not revert the promoted `issue_key` back to
`UNATTRIBUTED`. That's deliberate, not an oversight — see the comment
right above the `ON CONFLICT` clause in that file before changing it.

### Architecture: how the pieces connect, for testing locally

```
 claude (typed / IDE / CI)
        │  PATH search finds the shim first (cli-wrapper/shim/, via
        │  /etc/paths.d — see cli-wrapper/install-path-shim.sh)
        ▼
 devfinops-claude wrapper
        │  resolves issue key (explicit/branch) + developer id (git email)
        │  mints a session id, tags OTEL_RESOURCE_ATTRIBUTES
        │  execs the REAL claude binary (DEVFINOPS_CLAUDE_BIN)
        ▼
 real Claude Code session
        │  OTLP export (traces/logs) ──────────────► OTel Collector
        │  git commit, if any, during the session          │ file exporter
        │  (needs cli-wrapper/git-hooks/ installed          ▼
        │   in THAT repo — see install-git-hooks.js)  landing_zone/*.jsonl
        │        │                                          │
        │        ▼                                          │
        │  git_commits.jsonl  ◄───────────────────────────────
        │        │
        ▼        ▼
   ingestion-service/ingest.js  (npm run ingest)
        │  hashes developer_id, resolves session_id priority,
        │  loads raw_spans / raw_events / git_commits,
        │  runs db/04_derive_session_rollups.sql
        ▼
   Postgres (session_rollups, ticket_rollup, ...)
        │                                    ▲
        │                          jira_issues, separately, via
        │                   jira-listener.js (webhook) or
        ▼                   fetch-ticket.js (one-shot pull)
   Grafana (grafana_reader role — see db/05_access_control.sql)
```

To exercise this whole path locally without spending real Claude Code
usage, point `DEVFINOPS_CLAUDE_BIN` at any stand-in that creates a file
and commits it — the wrapper, hooks, and ingestion don't care whether
the child process is the real `claude` or not, only that it behaves
like a normal process the shell spawns:

```sh
cat > /tmp/fake-claude <<'EOF'
#!/bin/sh
echo "test" > devfinops-test.md
git add devfinops-test.md
git commit -m "devfinops pipeline test"
EOF
chmod +x /tmp/fake-claude

cd /path/to/a/repo/with/the/git/hooks/installed
DEVFINOPS_CLAUDE_BIN=/tmp/fake-claude node /path/to/devfinops-poc/cli-wrapper/devfinops-claude.js --issue PROJ-101
```

Then `npm run ingest` in `ingestion-service/` and check `git_commits` for
a real row — `commit_sha`, `session_id`, `issue_key` all genuine, tied to
an actual commit trailer, no Claude Code usage required. This proves the
git-correlation half of the pipeline (hooks → trailer → `git_commits.jsonl`
→ `git_commits` table) end to end. It won't produce a `session_rollups`
row, though — a plain shell stand-in doesn't emit OTel telemetry the way
a real Claude Code session does, so there's no `raw_spans`/`raw_events`
for `ingest.js` to derive one from. Testing that half for real still
needs the actual `claude` binary.

## Environment variables

See [`.env.example`](.env.example) for the full list with defaults and
explanations. Summary:

| Variable | Used by | Default |
|---|---|---|
| `POSTGRES_PASSWORD` | docker compose | `devfinops` |
| `JIRA_WEBHOOK_SECRET` | docker compose (jira-listener) | `changeme` |
| `GF_SECURITY_ADMIN_PASSWORD` | docker compose (grafana) | `devfinops` |
| `DATABASE_URL` | `ingestion-service/ingest.js` | `postgres://devfinops:devfinops@localhost:5432/devfinops` |
| `LANDING_ZONE_DIR` | `ingestion-service/ingest.js` | `./landing_zone` |
| `DEVFINOPS_ID_SALT` | `ingestion-service/ingest.js` | placeholder — change before real use |
| `DEVFINOPS_CLAUDE_BIN` | `cli-wrapper/devfinops-claude.js` | `claude` |
| `DEVFINOPS_OTLP_ENDPOINT` | `cli-wrapper/devfinops-claude.js` | `http://localhost:4317` |
| `JIRA_HOST`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` | `fetch-ticket.js`, `ingest.js` (auto-fetch) | none — auto-fetch skips (with a warning) if unset |
| `JIRA_STORY_POINTS_FIELD` | `jira-listener.js`, `fetch-ticket.js`, `ingest.js` | `customfield_10016` |

Only the first three are read automatically by `docker compose` (from a
`.env` file in the repo root, if present); the rest are for the Node
scripts you run directly and need to be exported in your shell.

## Repo layout

| Path | What |
|---|---|
| `cli-wrapper/` | `devfinops-claude` — wraps the real Claude Code CLI, tags sessions, ships the git hooks and the PATH shim (`shim/`, `install-path-shim.sh`) |
| `collector-config/` | OTel Collector config — receives OTLP, writes `landing_zone/*.jsonl` |
| `ingestion-service/` | Batch loader: `landing_zone/*.jsonl` → Postgres, plus the active/wait-time derivation |
| `jira-listener/` | Webhook receiver keeping `jira_issues` in sync (status/summary/points only) |
| `db/` | Schema and derived views, auto-applied to Postgres on first container boot |
| `grafana/` | Dashboard + read-only datasource provisioning |
| `landing_zone/` | Where telemetry JSONL lands — gitignored, created empty |

## Known limitations (by design, for this POC)

- `db/*.sql` only runs automatically on a **fresh** Postgres volume
  (`docker-entrypoint-initdb.d` behavior). If you change a schema file
  after `docker compose up` has already initialized the volume, apply it
  by hand (`docker exec -i devfinops-postgres psql -U devfinops -d
  devfinops -f - < db/whatever.sql`) or start over with `docker compose
  down -v`.
- No seed/demo data ships with this repo — the dashboard is genuinely
  empty until real sessions are ingested.
- Passwords in `.env.example` are placeholders, not secrets — see the
  file's own comments before this touches anything beyond a laptop.
