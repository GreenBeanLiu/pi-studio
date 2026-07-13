BEGIN;

SET LOCAL ROLE trailai;

ALTER FUNCTION pi_studio.validate_installation_account_owner()
  SET search_path = pi_studio, pg_temp;
ALTER FUNCTION pi_studio.validate_workflow_run_owner()
  SET search_path = pi_studio, pg_temp;

INSERT INTO pi_studio.schema_migrations (version)
VALUES ('005_owner_function_search_path')
ON CONFLICT (version) DO NOTHING;

COMMIT;
