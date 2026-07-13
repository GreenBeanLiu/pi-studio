BEGIN;

SET LOCAL ROLE trailai;
SET LOCAL search_path TO pi_studio, public;

CREATE OR REPLACE FUNCTION validate_installation_account_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pi_studio, pg_temp
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND NEW.installation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM account_installations
    WHERE account_id = NEW.account_id AND installation_id = NEW.installation_id
  ) THEN
    RAISE EXCEPTION 'installation % is not linked to account %', NEW.installation_id, NEW.account_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflows_owner_integrity
  BEFORE INSERT OR UPDATE OF installation_id, account_id ON workflows
  FOR EACH ROW EXECUTE FUNCTION validate_installation_account_owner();
CREATE TRIGGER workflow_runs_owner_integrity
  BEFORE INSERT OR UPDATE OF installation_id, account_id ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION validate_installation_account_owner();
CREATE TRIGGER image_jobs_owner_integrity
  BEFORE INSERT OR UPDATE OF installation_id, account_id ON image_jobs
  FOR EACH ROW EXECUTE FUNCTION validate_installation_account_owner();
CREATE TRIGGER publish_jobs_owner_integrity
  BEFORE INSERT OR UPDATE OF installation_id, account_id ON publish_jobs
  FOR EACH ROW EXECUTE FUNCTION validate_installation_account_owner();

CREATE OR REPLACE FUNCTION validate_workflow_run_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pi_studio, pg_temp
AS $$
DECLARE
  workflow_installation_id uuid;
  workflow_account_id uuid;
BEGIN
  IF NEW.workflow_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT installation_id, account_id
    INTO workflow_installation_id, workflow_account_id
    FROM workflows WHERE id = NEW.workflow_id;
  IF workflow_account_id IS NOT NULL THEN
    IF NEW.account_id IS DISTINCT FROM workflow_account_id THEN
      RAISE EXCEPTION 'run owner does not match workflow account owner' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.installation_id IS DISTINCT FROM workflow_installation_id THEN
    RAISE EXCEPTION 'run owner does not match workflow installation owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_workflow_owner_integrity
  BEFORE INSERT OR UPDATE OF workflow_id, installation_id, account_id ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION validate_workflow_run_owner();

INSERT INTO schema_migrations (version)
VALUES ('004_owner_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
