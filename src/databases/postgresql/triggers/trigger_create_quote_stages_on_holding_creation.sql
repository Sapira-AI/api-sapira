DROP TRIGGER IF EXISTS "trigger_create_quote_stages_on_holding_creation" ON "public"."company_holdings";

CREATE TRIGGER "trigger_create_quote_stages_on_holding_creation"
AFTER INSERT
ON "public"."company_holdings"
FOR EACH ROW
EXECUTE FUNCTION create_quote_stages_for_new_holding();
