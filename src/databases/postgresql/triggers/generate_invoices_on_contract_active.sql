DROP TRIGGER IF EXISTS "generate_invoices_on_contract_active" ON "public"."contracts";

CREATE TRIGGER "generate_invoices_on_contract_active"
AFTER UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION trigger_generate_invoices_on_status_change();
