DROP TRIGGER IF EXISTS "trg_contract_item_pauses_updated_at" ON "public"."contract_item_pauses";

CREATE TRIGGER trg_contract_item_pauses_updated_at BEFORE UPDATE ON public.contract_item_pauses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
