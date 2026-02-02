DROP TRIGGER IF EXISTS "trigger_check_partner_by_tax_id_before_insert" ON "public"."odoo_partners_stg";

CREATE TRIGGER "trigger_check_partner_by_tax_id_before_insert"
BEFORE UPDATE OR INSERT
ON "public"."odoo_partners_stg"
FOR EACH ROW
EXECUTE FUNCTION "public"."check_partner_by_tax_id_before_insert"();