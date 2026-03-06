DROP TRIGGER IF EXISTS "trigger_auto_populate_invoice_tax_rate" ON "public"."invoices";

CREATE TRIGGER "trigger_auto_populate_invoice_tax_rate"
BEFORE INSERT OR UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION auto_populate_invoice_tax_rate();
