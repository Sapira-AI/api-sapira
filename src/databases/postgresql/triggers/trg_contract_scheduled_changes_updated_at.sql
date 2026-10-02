DROP TRIGGER IF EXISTS "trg_contract_scheduled_changes_updated_at" ON "public"."contract_scheduled_changes";

CREATE TRIGGER trg_contract_scheduled_changes_updated_at BEFORE UPDATE ON public.contract_scheduled_changes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
