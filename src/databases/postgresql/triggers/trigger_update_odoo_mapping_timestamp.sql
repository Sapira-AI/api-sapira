DROP TRIGGER IF EXISTS "trigger_update_odoo_mapping_timestamp" ON "public"."odoo_object_mappings";

CREATE TRIGGER "trigger_update_odoo_mapping_timestamp"
BEFORE UPDATE
ON "public"."odoo_object_mappings"
FOR EACH ROW
EXECUTE FUNCTION update_odoo_mapping_updated_at();
