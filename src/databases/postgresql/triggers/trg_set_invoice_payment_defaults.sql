DROP TRIGGER IF EXISTS "trg_set_invoice_payment_defaults" ON "public"."invoice_payments";

CREATE TRIGGER "trg_set_invoice_payment_defaults"
BEFORE INSERT
ON "public"."invoice_payments"
FOR EACH ROW
EXECUTE FUNCTION set_invoice_payment_defaults();
