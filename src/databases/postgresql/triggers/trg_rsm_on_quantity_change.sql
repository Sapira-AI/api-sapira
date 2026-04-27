DROP TRIGGER IF EXISTS "trg_rsm_on_quantity_change" ON "public"."quantities";

CREATE TRIGGER "trg_rsm_on_quantity_change"
AFTER INSERT OR UPDATE
ON "public"."quantities"
FOR EACH ROW
EXECUTE FUNCTION trigger_rsm_on_quantity_change();
