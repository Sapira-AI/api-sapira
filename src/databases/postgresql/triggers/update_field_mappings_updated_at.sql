DROP TRIGGER IF EXISTS "update_field_mappings_updated_at" ON "public"."field_mappings";

CREATE TRIGGER "update_field_mappings_updated_at"
BEFORE UPDATE
ON "public"."field_mappings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
