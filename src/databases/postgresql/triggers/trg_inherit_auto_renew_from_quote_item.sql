DROP TRIGGER IF EXISTS "trg_inherit_auto_renew_from_quote_item" ON "public"."contract_items";

CREATE TRIGGER "trg_inherit_auto_renew_from_quote_item"
BEFORE INSERT
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION inherit_auto_renew_from_quote_item();
