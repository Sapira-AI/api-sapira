DROP TRIGGER IF EXISTS "trigger_update_holding_email_sender_updated_at" ON "public"."holding_email_sender_settings";

CREATE TRIGGER "trigger_update_holding_email_sender_updated_at"
BEFORE UPDATE
ON "public"."holding_email_sender_settings"
FOR EACH ROW
EXECUTE FUNCTION update_holding_email_sender_updated_at();
