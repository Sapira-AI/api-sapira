DROP TRIGGER IF EXISTS "trg_invoice_references_updated_at" ON "public"."invoice_references";

CREATE TRIGGER "trg_invoice_references_updated_at"
BEFORE UPDATE
ON "public"."invoice_references"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
