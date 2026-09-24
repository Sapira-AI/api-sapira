DROP TRIGGER IF EXISTS "client_activity_notes_set_updated_at" ON "public"."client_activity_notes";

CREATE TRIGGER "client_activity_notes_set_updated_at"
BEFORE UPDATE
ON "public"."client_activity_notes"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
