DROP TRIGGER IF EXISTS "classify_invoice_line_trigger" ON "public"."odoo_invoice_lines_stg";

CREATE TRIGGER "classify_invoice_line_trigger"
BEFORE INSERT
ON "public"."odoo_invoice_lines_stg"
FOR EACH ROW
EXECUTE FUNCTION "public"."classify_invoice_line_before_insert"();