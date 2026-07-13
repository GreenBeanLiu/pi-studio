BEGIN;

CREATE SCHEMA IF NOT EXISTS pi_studio AUTHORIZATION trailai;
SET LOCAL ROLE trailai;
SET LOCAL search_path TO pi_studio, public;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id uuid PRIMARY KEY,
  display_name text,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name text NOT NULL,
  input text,
  workspace_path text NOT NULL,
  schedule jsonb NOT NULL DEFAULT '{"type":"manual"}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  notify_mode text NOT NULL DEFAULT 'never'
    CHECK (notify_mode IN ('always', 'error', 'never')),
  notify_channel_id text,
  push_each_step boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  last_slot_key text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL,
  type text NOT NULL CHECK (
    type IN ('agent', 'imagegen', 'review', 'notify', 'export', 'feishu-doc', 'wechat-draft')
  ),
  prompt text,
  engine text CHECK (engine IS NULL OR engine IN ('openai', 'comfy')),
  channel_id text,
  message_template text,
  artifact_path text,
  artifact_format text CHECK (artifact_format IS NULL OR artifact_format IN ('markdown', 'html')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, position)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  workflow_name text NOT NULL,
  trigger_source text NOT NULL DEFAULT 'manual'
    CHECK (trigger_source IN ('manual', 'schedule', 'retry', 'api')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ok', 'error', 'timeout', 'cancelled')),
  input_snapshot text,
  summary text,
  error text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES workflow_steps(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position >= 0),
  step_name text NOT NULL,
  step_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ok', 'error', 'timeout', 'skipped', 'cancelled')),
  summary text,
  image_url text,
  artifact_path text,
  error text,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);

CREATE TABLE IF NOT EXISTS image_jobs (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_run_id uuid REFERENCES workflow_step_runs(id) ON DELETE SET NULL,
  engine text NOT NULL CHECK (engine IN ('openai', 'comfy')),
  provider text,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ok', 'error', 'cancelled')),
  remote_id text,
  public_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_step_run_id uuid REFERENCES workflow_step_runs(id) ON DELETE SET NULL,
  target text NOT NULL CHECK (target IN ('feishu', 'wechat')),
  channel_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ok', 'error', 'cancelled')),
  idempotency_key text NOT NULL UNIQUE,
  external_id text,
  external_url text,
  request_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS workflows_installation_updated_idx
  ON workflows (installation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_created_idx
  ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_installation_status_idx
  ON workflow_runs (installation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_step_runs_run_idx
  ON workflow_step_runs (workflow_run_id, position);
CREATE INDEX IF NOT EXISTS image_jobs_installation_created_idx
  ON image_jobs (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publish_jobs_installation_created_idx
  ON publish_jobs (installation_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('001_pi_studio_core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
