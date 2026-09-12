---
name: setup
description: "Use when setting up Emporos on a host machine, local checkout, linked worktree, or cloud VM. Run the canonical bootstrap path, surface required human actions, and keep ports on the repo contract."
disable-model-invocation: true
---

# Setup Skill

Use this skill to make host setup deterministic. The agent owns discovery,
preflight checks, and reruns. The human owns external actions the agent cannot
complete directly, such as authenticating a CLI, starting Docker Desktop,
granting access to a dashboard, or approving a process kill.

## Required Reading

Before running setup commands, read the branch-relevant canonical docs:

- `docs/DEVELOPMENT.md` for first-time setup, worktree setup, commands, fixed
  ports, and webhook tunnel requirements.
- `docs/debug/local-services.md` for local service commands and Docker service
  ports.
- `docs/references/doppler.md` when Doppler projects, configs, or secrets are
  involved.
- `docs/debug/database.md` and `docs/references/database.md` when touching the
  app database, host Postgres, migrations, or worktree databases.
- `docs/CLOUD.md` only when the host is a cloud VM.

Completion criterion: the setup branch, required commands, required secrets, and
port contract are known from repo docs or scripts, not guessed.

## Choose The Branch

Pick exactly one branch before mutating the host:

- Main checkout: run the first-time setup path. Do not run
  `pnpm setup:worktree` in the main checkout.
- Linked git worktree: run the worktree setup path from inside that worktree.
  The setup writes that worktree's `.env` with isolated database values.
- Plane runner: follow `docs/CLOUD.md` and run `pnpm setup:cloud`. Plane owns
  the toolchain, Docker daemon, and ephemeral Doppler credential; the Emporos
  command owns repo dependencies, local services, the app database, and ports.

Completion criterion: `pwd`, `git rev-parse --show-toplevel`, and
`git worktree list` agree with the selected branch.

## Human Action Gate

When setup blocks on something outside the repository process, ask the user for
the exact action and wait for confirmation before retrying. Do this for:

- CLI authentication: `doppler login`, Cloudflare login/dashboard work,
  `wrangler login`, `gh auth login`, or similar browser/device-code flows.
- Desktop service state: starting Docker Desktop or local Postgres.
- Secret/dashboard edits: adding Doppler secrets, Cloudflare tunnel hostnames,
  Microsoft callback URLs, or other external configuration.
- Host-level permissions: sudo prompts, Keychain prompts, firewall prompts, or
  installing tools when the command requires user approval.
- Killing a process that still owns a required port after guarded cleanup.

Ask with the failing check, the exact command or UI action, and the command you
will rerun after the user confirms. Do not switch to a hidden fallback or skip a
requirement to make progress.

Completion criterion: the same check that failed now succeeds, or setup stops
with the human-visible blocker preserved.

## Port Contract

Use the repo's expected ports. Do not pick random spare ports, do not accept
Next.js auto-increment as success, and do not pass ad hoc `--port` values to
dodge conflicts.

| Port          | Owner                                                         |
| ------------- | ------------------------------------------------------------- |
| `3000`        | frontend / local OAuth redirects                              |
| `3001`        | `webhook-ingress`                                             |
| `3002`        | `log-ingress`                                                 |
| `3011`        | v1 worker health                                              |
| `3012`        | v2 worker health                                              |
| `8080`        | backend `PORT` in local dev Doppler                           |
| `8787`        | router-worker                                                 |
| `8788`        | sandbox-worker                                                |
| `5432`        | host Postgres for the main checkout                           |
| `6379`        | Redis from Docker Compose                                     |
| `7233`        | Temporal server                                               |
| `8233`        | Temporal UI                                                   |
| `9428`        | VictoriaLogs                                                  |
| `10428`       | VictoriaTraces                                                |
| `3100`        | Grafana                                                       |
| `20000-39999` | linked worktree Postgres containers, stable hash-derived port |

Some scripts contain port env vars for code-owned maintenance, CI isolation, or
rare infrastructure moves. Treat them as implementation details during host
setup. If a standard port is occupied, clear the conflict with the Port Conflict
Procedure instead of changing the port. If a port change is truly required,
update the code, Doppler values, tunnel/dashboard routes, and docs as one
intentional change before setup continues.

Completion criterion: every expected listener is either free before startup or
owned by the service that should own it after startup.

## Port Conflict Procedure

When a required port is occupied:

1. Identify the listener with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
2. Run `pnpm kill-dev` from the repo root first. It uses Emporos PID files and a
   guarded port scan to stop only recognized Emporos dev processes.
3. Recheck the port with `lsof`.
4. If the listener remains, show the user the port, PID, command, and current
   working directory when available. Ask: "Can I stop PID <pid> to free port
   <port> for Emporos setup?"
5. Only after approval, send `TERM` to the approved PID or process tree. Recheck
   the port.
6. If `TERM` fails, ask before using `KILL`.

Completion criterion: the port is free, the approved process is stopped, or the
user declines and setup stops without changing the port contract.

## Main Checkout Setup

Run from the main checkout:

```bash
bash bin/setup.sh
docker compose up -d
pnpm migrate
```

`bin/setup.sh` verifies Node 22, verifies pnpm 10, installs dependencies, checks
`doppler`, `psql`, Docker, `cloudflared`, and `wrangler`, then runs
`pnpm init-database`. If the script reports missing requirements, use the Human
Action Gate, complete the requirement, and rerun the same command.

For dev startup:

- Use `pnpm dev` for full local development with the Cloudflare tunnel.
- Use `pnpm dev:no-tunnel` when webhook delivery is not needed.
- Use `pnpm dev:frontend` only for frontend-only work.

Completion criterion: dependencies are installed, Docker services are running,
migrations apply, and the selected dev command starts on the expected ports.

## Linked Worktree Setup

Run from inside the linked worktree:

```bash
pnpm setup:worktree
docker compose up -d
```

The worktree setup verifies Node and pnpm, installs dependencies, provisions the
isolated Postgres container, applies migrations, seeds the app database, and
writes `DATABASE_URL`, `SHADOW_DATABASE_URL`, `EMPOROS_WORKTREE_DB_CONTAINER`,
and `EMPOROS_WORKTREE_DB_PORT` to the worktree `.env`.

Use `pnpm worktree:clean` from that worktree to remove its database container
when the worktree is retired.

Completion criterion: `.env` exists with the worktree DB values, the stored DB
container is running, and the selected dev command can load the worktree `.env`.

## Plane Runner Setup

Enter through Plane so the runtime credential is forwarded, then run the
canonical setup:

```bash
plane ssh <workspace>
cd /workspace/emporos
pnpm setup:cloud
```

Then run `pnpm dev` for the foreground stack and its per-workspace Cloudflare
tunnel. Do not install nvm, Node, pnpm, Docker, or Doppler inside the runner and
do not run `doppler login`; those are Plane responsibilities.

Completion criterion: Doppler access checks pass, Compose services and the
checkout-local Postgres container are running, `.env` contains the app and
shadow database URLs, and `ports.json` contains the forwarding contract.

## External Configuration Checklist

For full tunnel setup, verify these before declaring the host ready:

- Doppler CLI is installed and `doppler me --silent` succeeds.
- `backend/dev_personal` resolves `PORT=8080`, `WEBHOOK_WORKER_URL`,
  `WEBHOOK_WORKER_API_KEY`, `CLOUDFLARE_TUNNEL_TOKEN`,
  `SCRIPT_RUNTIME_TOOL_CALL_SECRET`, `DOMAIN`, and `DEV_NAME` or a valid user
  fallback.
- `webhook-ingress/dev_personal` resolves `WEBHOOK_INGRESS_PORT=3001` or leaves
  it unset so the service default is `3001`.
- `log-ingress/dev_personal` resolves `LOG_INGRESS_SHARED_SECRET`,
  `VICTORIA_LOGS_BASE_URL=http://localhost:9428`, and `LOG_INGRESS_PORT=3002`
  or leaves it unset so the service default is `3002`.
- `router-worker/dev` resolves `CEREBRAS_API_KEY` and `PROXY_SHARED_SECRET`.
- `sandbox/dev_personal` resolves `SANDBOX_SERVICE_TOKEN`.
- Cloudflare has `${DEV_NAME}-local.${DOMAIN}` routed to
  `http://localhost:3001`.
- Cloudflare has `${DEV_NAME}-local-router.${DOMAIN}` routed to
  `http://localhost:8787`.
- `frontend/dev_personal` has `NEXT_PUBLIC_DEV_NAME` when local OAuth callback
  flows need the worker callback routes.

Completion criterion: the required secret checks pass under `doppler run` or
`doppler secrets get --plain --silent`, and no secret value has been printed into
the conversation or committed files.

## Verification

Use the smallest verification that proves the selected branch:

- `node --version` reports Node 22.x.
- `pnpm --version` reports pnpm 10.x.
- `docker info` succeeds.
- `docker compose ps` shows the expected infrastructure containers.
- `doppler me --silent` succeeds when Doppler-backed setup is required.
- `pnpm migrate` succeeds for the main checkout, or `pnpm setup:worktree`
  succeeds for a linked worktree.
- The chosen dev command starts without port drift.
- Health checks pass for services started by the chosen branch:
  `http://localhost:3001/health`, `http://localhost:3002/health`,
  `http://localhost:8787/health`, or `http://localhost:8788/health` as
  applicable.

Completion criterion: report the branch, commands run, human actions requested,
ports verified, and any remaining blocker with the exact failing check.
