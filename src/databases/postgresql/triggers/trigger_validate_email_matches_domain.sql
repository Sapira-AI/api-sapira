DROP TRIGGER IF EXISTS "trigger_validate_email_matches_domain" ON "public"."email_sender_addresses";

CREATE TRIGGER "trigger_validate_email_matches_domain"
BEFORE INSERT OR UPDATE
ON "public"."email_sender_addresses"
FOR EACH ROW
EXECUTE FUNCTION validate_email_matches_domain();
