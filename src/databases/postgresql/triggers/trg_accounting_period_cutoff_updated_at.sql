DROP TRIGGER IF EXISTS "trg_accounting_period_cutoff_updated_at" ON "public"."accounting_period_cutoff";

CREATE TRIGGER trg_accounting_period_cutoff_updated_at BEFORE UPDATE ON public.accounting_period_cutoff FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_accounting_period_cutoff();
