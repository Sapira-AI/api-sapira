DROP TRIGGER IF EXISTS "trigger_revenue_schedule_after_credit_note" ON "public"."invoice_credit_notes";

CREATE TRIGGER "trigger_revenue_schedule_after_credit_note"
AFTER INSERT OR UPDATE
ON "public"."invoice_credit_notes"
FOR EACH ROW
EXECUTE FUNCTION trigger_revenue_schedule_on_credit_note();
