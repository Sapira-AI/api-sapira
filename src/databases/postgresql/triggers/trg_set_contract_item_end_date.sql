DROP TRIGGER IF EXISTS "trg_set_contract_item_end_date" ON "public"."contract_items";

CREATE TRIGGER "trg_set_contract_item_end_date"
BEFORE INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION set_contract_item_end_date();
