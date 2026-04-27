DROP TRIGGER IF EXISTS "trigger_update_generic_export_vats_updated_at" ON "public"."generic_export_vats";

CREATE TRIGGER "trigger_update_generic_export_vats_updated_at"
BEFORE UPDATE
ON "public"."generic_export_vats"
FOR EACH ROW
EXECUTE FUNCTION update_generic_export_vats_updated_at();
