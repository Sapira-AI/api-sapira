DROP TRIGGER IF EXISTS "trg_mrr_legacy_updated_at" ON "public"."mrr_legacy";

CREATE TRIGGER "trg_mrr_legacy_updated_at"
BEFORE UPDATE
ON "public"."mrr_legacy"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
