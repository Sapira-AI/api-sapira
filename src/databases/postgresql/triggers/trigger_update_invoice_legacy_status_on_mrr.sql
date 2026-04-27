DROP TRIGGER IF EXISTS "trigger_update_invoice_legacy_status_on_mrr" ON "public"."mrr_legacy";

CREATE TRIGGER "trigger_update_invoice_legacy_status_on_mrr"
AFTER INSERT
ON "public"."mrr_legacy"
FOR EACH ROW
EXECUTE FUNCTION update_invoice_legacy_status_on_mrr_creation();
