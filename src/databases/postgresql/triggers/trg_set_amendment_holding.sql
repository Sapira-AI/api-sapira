DROP TRIGGER IF EXISTS "trg_set_amendment_holding" ON "public"."contract_amendments";

CREATE TRIGGER "trg_set_amendment_holding"
BEFORE INSERT
ON "public"."contract_amendments"
FOR EACH ROW
EXECUTE FUNCTION set_contract_amendment_holding_id();
