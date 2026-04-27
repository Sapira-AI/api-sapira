DROP TRIGGER IF EXISTS "trg_calculate_mrr_legacy_fields" ON "public"."mrr_legacy";

CREATE TRIGGER "trg_calculate_mrr_legacy_fields"
BEFORE INSERT OR UPDATE
ON "public"."mrr_legacy"
FOR EACH ROW
EXECUTE FUNCTION calculate_mrr_legacy_fields();
