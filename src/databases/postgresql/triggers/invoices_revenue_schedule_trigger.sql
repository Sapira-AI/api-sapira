DROP TRIGGER IF EXISTS "invoices_revenue_schedule_trigger" ON "public"."invoices";

CREATE TRIGGER "invoices_revenue_schedule_trigger"
AFTER DELETE OR INSERT OR UPDATE
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION trigger_revenue_schedule_update();
