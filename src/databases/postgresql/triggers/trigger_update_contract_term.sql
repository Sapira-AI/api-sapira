DROP TRIGGER IF EXISTS "trigger_update_contract_term" ON "public"."contract_items";

CREATE TRIGGER "trigger_update_contract_term"
AFTER DELETE OR INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION update_contract_term();
