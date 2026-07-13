# Persistence inventory

pi-studio currently has no relational database. Persistent state is split between JSON/files,
Pi session files, the selected workspace, Docker, and remote integrations.

## Current local state

| Location | Data | Keep as files? | Future database candidate |
| --- | --- | --- | --- |
| `userData/settings.json` | Provider/model settings, recent workspaces, encrypted API keys | Yes | No |
| `userData/channels.json` | Feishu/WeChat/webhook channel configuration and encrypted secrets | Yes | No; secrets must remain in OS-protected storage |
| `userData/routines.json` | Workflows, steps, schedules, recent runs and step results | Temporary | Yes |
| `userData/security-policies.json` | Default/workspace command and write policies | Yes | No |
| `userData/pi-agent/sessions/**` | Pi conversation JSONL and session metadata | Yes; Pi is source of truth | Index only, do not duplicate full messages |
| `userData/pi-agent/models.json` | Generated provider/model override | Yes; generated file | No |
| `userData/logs/**` | Application diagnostics | Yes, with retention limit | No |
| `userData/sandbox/**` | Generated Dockerfile and RPC shim | Regenerable | No |
| `<workspace>/.pi-studio/memory.md` | Workspace memory maintained with the project | Yes | No |
| `<workspace>/.pi-studio/articles/**` | Exported Markdown/HTML article artifacts | Yes | Metadata only |

## Remote and external state

| System | Data |
| --- | --- |
| Cloud image relay | Generated-image jobs/history and image URLs |
| Model providers / Helicone | Prompts, responses, usage and optional request logs according to provider settings |
| Feishu | Cards, documents and uploaded document images |
| WeChat | Uploaded permanent cover material, inline images and draft media IDs |
| Docker | Versioned `pi-studio-sandbox:<pi-version>` images outside AppData |

## Proposed structured database

The next version should use PostgreSQL behind the TrailAI backend for state that benefits from
querying, cross-device sync, retention, idempotency, or migrations. The desktop app must use an
authenticated backend API; it must never connect to PostgreSQL directly.

The initial migration is `database/migrations/001_pi_studio_core.sql` and uses an isolated
`pi_studio` schema in the existing `trailai` database:

1. `schema_migrations`
   - `version`, `applied_at`
2. `installations`
   - anonymous desktop installation identity and app version; no hardware fingerprint
3. `workflows`
   - identity, name, input, workspace, schedule, enabled, notification configuration
4. `workflow_steps`
   - workflow order, type, prompt/template and engine/channel references
5. `workflow_runs`
   - status, trigger source, start/end time, summary and top-level error
6. `workflow_step_runs`
   - per-step status, duration, text summary, artifact reference and error
7. `image_jobs`
   - local job ID, engine/provider, prompt, status, remote ID/URL and timestamps; image bytes stay in files/R2
8. `publish_jobs`
   - target (`feishu`/`wechat`), workflow run, status, idempotency key, external document/media ID and error

Migration `002_installation_auth_accounts.sql` adds hashed per-installation bearer tokens plus
`accounts` and `account_installations`. Login remains optional: anonymous data is owned by one
installation, while a later login can link installations and expose account-owned data across devices.
Migration `003_account_owned_records.sql` makes the installation owner nullable once an account owns
the record, so removing a linked device cannot delete account-owned workflows or history.
Migration `004_owner_integrity.sql` enforces installation/account links and prevents a run from being
attached to a workflow owned by another installation or account.
Migration `005_owner_function_search_path.sql` pins the trigger lookup path so the same constraints
work for backend connections whose default schema is `public`.
Migration `006_preserve_account_records_on_unlink.sql` clears the creator installation from
account-owned rows before unlinking a device, preserving the ownership invariant and the data.

Do not put API keys, AppSecrets, access tokens, full Pi JSONL sessions, generated image bytes,
or Docker images in PostgreSQL.

## Repository boundary

Commit:

- `src/**`, `tests/**`, `scripts/**`, `docs/**`, `.github/**`
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- dependency patches under `patches/**`
- build configuration and source icons

Never commit:

- `node_modules/**`, `out/**`, `dist/**`, `*.tsbuildinfo`
- AppData/userData files, logs, Pi sessions, local Docker images
- API keys, webhook secrets, AppSecrets, access tokens or exported diagnostics
