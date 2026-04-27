DROP TRIGGER IF EXISTS "trg_quantities_set_holding" ON "public"."quantities";

CREATE TRIGGER "trg_quantities_set_holding"
BEFORE INSERT
ON "public"."quantities"
FOR EACH ROW
EXECUTE FUNCTION quantities_set_holding_from_contract_item();
