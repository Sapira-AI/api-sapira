DROP TRIGGER IF EXISTS "trg_calculate_mrr_legacy_system_currency" ON "public"."mrr_legacy";

CREATE TRIGGER "trg_calculate_mrr_legacy_system_currency"
BEFORE INSERT OR UPDATE
ON "public"."mrr_legacy"
FOR EACH ROW
EXECUTE FUNCTION calculate_mrr_legacy_system_currency();
