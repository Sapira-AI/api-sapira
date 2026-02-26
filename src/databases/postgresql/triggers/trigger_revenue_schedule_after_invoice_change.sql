DROP TRIGGER IF EXISTS "trigger_revenue_schedule_after_invoice_change" ON "public"."invoices";

CREATE TRIGGER "trigger_revenue_schedule_after_invoice_change"
AFTER INSERT OR UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION trigger_revenue_schedule_on_invoice_change();
