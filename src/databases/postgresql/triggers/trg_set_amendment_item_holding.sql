DROP TRIGGER IF EXISTS "trg_set_amendment_item_holding" ON "public"."contract_amendment_items";

CREATE TRIGGER "trg_set_amendment_item_holding"
BEFORE INSERT
ON "public"."contract_amendment_items"
FOR EACH ROW
EXECUTE FUNCTION set_contract_amendment_item_holding_id();
