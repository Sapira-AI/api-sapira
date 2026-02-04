DROP TRIGGER IF EXISTS "update_invoice_line_timestamp_trigger" ON "public"."odoo_invoice_lines_stg";

CREATE TRIGGER "update_invoice_line_timestamp_trigger"
BEFORE UPDATE
ON "public"."odoo_invoice_lines_stg"
FOR EACH ROW
EXECUTE FUNCTION "public"."update_invoice_line_timestamp"();