DROP TRIGGER IF EXISTS "unified_generate_invoices_on_contract_signed" ON "public"."contracts";

CREATE TRIGGER "unified_generate_invoices_on_contract_signed"
AFTER INSERT OR UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION trigger_generate_invoices_on_contract_signed();
