DROP TRIGGER IF EXISTS "trg_budget_lines_updated_at" ON "public"."budget_lines";

CREATE TRIGGER trg_budget_lines_updated_at BEFORE UPDATE ON public.budget_lines FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
