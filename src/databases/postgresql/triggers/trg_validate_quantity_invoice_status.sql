DROP TRIGGER IF EXISTS "trg_validate_quantity_invoice_status" ON "public"."quantities";

CREATE TRIGGER trg_validate_quantity_invoice_status BEFORE INSERT OR DELETE OR UPDATE ON public.quantities FOR EACH ROW EXECUTE FUNCTION validate_invoice_status_for_quantity_change();
