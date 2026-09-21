DROP TRIGGER IF EXISTS "trg_cutoff_validate_company_holding" ON "public"."accounting_period_cutoff";

CREATE TRIGGER trg_cutoff_validate_company_holding BEFORE INSERT OR UPDATE OF holding_id, company_id ON public.accounting_period_cutoff FOR EACH ROW EXECUTE FUNCTION trg_validate_cutoff_company_holding_match();
