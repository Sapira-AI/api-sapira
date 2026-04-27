DROP TRIGGER IF EXISTS "trg_mrr_adjustments_updated_at" ON "public"."mrr_adjustments";

CREATE TRIGGER "trg_mrr_adjustments_updated_at"
BEFORE UPDATE
ON "public"."mrr_adjustments"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
