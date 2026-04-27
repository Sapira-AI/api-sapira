DROP TRIGGER IF EXISTS "invoices_fill_terms_from_contract_trigger" ON "public"."invoices";

CREATE TRIGGER "invoices_fill_terms_from_contract_trigger"
BEFORE INSERT
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION invoices_fill_terms_from_contract();
