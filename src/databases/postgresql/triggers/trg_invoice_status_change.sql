DROP TRIGGER IF EXISTS "trg_invoice_status_change" ON "public"."invoices";

CREATE TRIGGER "trg_invoice_status_change"
AFTER UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION refresh_revenue_schedule_for_invoice_contract();
