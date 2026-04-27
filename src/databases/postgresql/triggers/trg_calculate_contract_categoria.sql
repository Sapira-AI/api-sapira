DROP TRIGGER IF EXISTS "trg_calculate_contract_categoria" ON "public"."contract_items";

CREATE TRIGGER "trg_calculate_contract_categoria"
BEFORE INSERT
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION trg_set_contract_item_categoria();
