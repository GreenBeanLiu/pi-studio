BEGIN;

SET LOCAL ROLE trailai;
SET LOCAL search_path TO pi_studio, public;

CREATE OR REPLACE FUNCTION preserve_account_owned_records_on_unlink()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pi_studio, pg_temp
AS $$
BEGIN
  UPDATE workflows SET installation_id = NULL
    WHERE account_id = OLD.account_id AND installation_id = OLD.installation_id;
  UPDATE workflow_runs SET installation_id = NULL
    WHERE account_id = OLD.account_id AND installation_id = OLD.installation_id;
  UPDATE image_jobs SET installation_id = NULL
    WHERE account_id = OLD.account_id AND installation_id = OLD.installation_id;
  UPDATE publish_jobs SET installation_id = NULL
    WHERE account_id = OLD.account_id AND installation_id = OLD.installation_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER account_installations_preserve_owned_records
  BEFORE DELETE ON account_installations
  FOR EACH ROW EXECUTE FUNCTION preserve_account_owned_records_on_unlink();

INSERT INTO schema_migrations (version)
VALUES ('006_preserve_account_records_on_unlink')
ON CONFLICT (version) DO NOTHING;

COMMIT;
