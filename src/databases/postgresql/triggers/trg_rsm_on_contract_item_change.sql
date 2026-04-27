DROP TRIGGER IF EXISTS "trg_rsm_on_contract_item_change" ON "public"."contract_items";

CREATE TRIGGER "trg_rsm_on_contract_item_change"
AFTER INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION trigger_rsm_on_contract_item_change();
