BEGIN;

SET LOCAL ROLE trailai;
SET LOCAL search_path TO pi_studio, public;

ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_installation_id_fkey;
ALTER TABLE workflows ALTER COLUMN installation_id DROP NOT NULL;
ALTER TABLE workflows
  ADD CONSTRAINT workflows_installation_id_fkey
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE SET NULL;
ALTER TABLE workflows
  ADD CONSTRAINT workflows_owner_check CHECK (installation_id IS NOT NULL OR account_id IS NOT NULL);

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_installation_id_fkey;
ALTER TABLE workflow_runs ALTER COLUMN installation_id DROP NOT NULL;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_installation_id_fkey
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_owner_check CHECK (installation_id IS NOT NULL OR account_id IS NOT NULL);

ALTER TABLE image_jobs DROP CONSTRAINT IF EXISTS image_jobs_installation_id_fkey;
ALTER TABLE image_jobs ALTER COLUMN installation_id DROP NOT NULL;
ALTER TABLE image_jobs
  ADD CONSTRAINT image_jobs_installation_id_fkey
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE SET NULL;
ALTER TABLE image_jobs
  ADD CONSTRAINT image_jobs_owner_check CHECK (installation_id IS NOT NULL OR account_id IS NOT NULL);

ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_installation_id_fkey;
ALTER TABLE publish_jobs ALTER COLUMN installation_id DROP NOT NULL;
ALTER TABLE publish_jobs
  ADD CONSTRAINT publish_jobs_installation_id_fkey
  FOREIGN KEY (installation_id) REFERENCES installations(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs
  ADD CONSTRAINT publish_jobs_owner_check CHECK (installation_id IS NOT NULL OR account_id IS NOT NULL);

INSERT INTO schema_migrations (version)
VALUES ('003_account_owned_records')
ON CONFLICT (version) DO NOTHING;

COMMIT;
