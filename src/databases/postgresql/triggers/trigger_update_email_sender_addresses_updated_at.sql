DROP TRIGGER IF EXISTS "trigger_update_email_sender_addresses_updated_at" ON "public"."email_sender_addresses";

CREATE TRIGGER "trigger_update_email_sender_addresses_updated_at"
BEFORE UPDATE
ON "public"."email_sender_addresses"
FOR EACH ROW
EXECUTE FUNCTION update_email_sender_addresses_updated_at();
