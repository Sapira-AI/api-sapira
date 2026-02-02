DROP TRIGGER IF EXISTS "update_odoo_partners_stg_updated_at" ON "public"."odoo_partners_stg";

CREATE TRIGGER "update_odoo_partners_stg_updated_at"
BEFORE UPDATE
ON "public"."odoo_partners_stg"
FOR EACH ROW
EXECUTE FUNCTION "public"."update_updated_at_column"();