DROP TRIGGER IF EXISTS "trg_events_validate_company_holding" ON "public"."accounting_period_events";

CREATE TRIGGER trg_events_validate_company_holding BEFORE INSERT ON public.accounting_period_events FOR EACH ROW EXECUTE FUNCTION trg_validate_cutoff_company_holding_match();
