DROP TRIGGER IF EXISTS "trg_rsm_on_churn" ON "public"."contracts";

CREATE TRIGGER "trg_rsm_on_churn"
AFTER UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION trigger_rsm_on_churn();
