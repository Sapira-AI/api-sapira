DROP TRIGGER IF EXISTS "trg_budgets_updated_at" ON "public"."budgets";

CREATE TRIGGER trg_budgets_updated_at BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
