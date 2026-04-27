DROP TRIGGER IF EXISTS "update_contact_preferences_updated_at" ON "public"."contact_preferences";

CREATE TRIGGER "update_contact_preferences_updated_at"
BEFORE UPDATE
ON "public"."contact_preferences"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
