DROP TRIGGER IF EXISTS "trg_rsm_on_invoice_change" ON "public"."invoices";

CREATE TRIGGER trg_rsm_on_invoice_change AFTER INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION trigger_rsm_on_invoice_change();
