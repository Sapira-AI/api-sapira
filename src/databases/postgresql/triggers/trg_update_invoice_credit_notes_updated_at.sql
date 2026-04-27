DROP TRIGGER IF EXISTS "trg_update_invoice_credit_notes_updated_at" ON "public"."invoice_credit_notes";

CREATE TRIGGER "trg_update_invoice_credit_notes_updated_at"
BEFORE UPDATE
ON "public"."invoice_credit_notes"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
