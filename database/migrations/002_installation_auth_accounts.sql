BEGIN;

SET LOCAL ROLE trailai;
SET LOCAL search_path TO pi_studio, public;

ALTER TABLE installations
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS token_created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS installations_token_hash_idx
  ON installations (token_hash)
  WHERE token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  email text,
  display_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_idx
  ON accounts (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_installations (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, installation_id),
  UNIQUE (installation_id)
);

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS workflows_account_updated_idx
  ON workflows (account_id, updated_at DESC)
  WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_account_created_idx
  ON workflow_runs (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('002_installation_auth_accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
