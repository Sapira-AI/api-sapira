DROP TRIGGER IF EXISTS "trg_recalc_after_delete" ON "public"."invoice_payments";

CREATE TRIGGER "trg_recalc_after_delete"
AFTER DELETE
ON "public"."invoice_payments"
FOR EACH ROW
EXECUTE FUNCTION after_invoice_payment_change();
