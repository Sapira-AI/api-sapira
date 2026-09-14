DROP TRIGGER IF EXISTS "trg_00_period_guard_contracts" ON "public"."contracts";

CREATE TRIGGER trg_00_period_guard_contracts BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION trg_period_guard_contracts();
