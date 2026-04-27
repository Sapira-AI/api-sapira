DROP TRIGGER IF EXISTS "trigger_validate_client_agent_config_email_sender" ON "public"."client_agent_configs";

CREATE TRIGGER "trigger_validate_client_agent_config_email_sender"
BEFORE INSERT OR UPDATE
ON "public"."client_agent_configs"
FOR EACH ROW
EXECUTE FUNCTION validate_client_agent_config_email_sender();
