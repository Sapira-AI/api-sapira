DROP TRIGGER IF EXISTS "trg_00_period_guard_contract_items" ON "public"."contract_items";

CREATE TRIGGER trg_00_period_guard_contract_items BEFORE INSERT OR DELETE OR UPDATE ON public.contract_items FOR EACH ROW EXECUTE FUNCTION trg_period_guard_contract_items();
