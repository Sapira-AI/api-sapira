DROP TRIGGER IF EXISTS "invoice_processing_status_classifier" ON "public"."odoo_invoices_stg";

CREATE TRIGGER "invoice_processing_status_classifier"
BEFORE INSERT
ON "public"."odoo_invoices_stg"
FOR EACH ROW
EXECUTE FUNCTION "public"."set_invoice_processing_status"();