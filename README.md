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

Only the first three are read automatically by `docker compose` (from a
`.env` file in the repo root, if present); the rest are for the Node
scripts you run directly and need to be exported in your shell.

## Repo layout

| Path | What |
|---|---|
| `cli-wrapper/` | `devfinops-claude` — wraps the real Claude Code CLI, tags sessions, ships the git hooks |
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
