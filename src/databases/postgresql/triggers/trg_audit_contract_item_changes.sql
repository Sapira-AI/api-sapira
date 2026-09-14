DROP TRIGGER IF EXISTS "trg_audit_contract_item_changes" ON "public"."contract_items";

CREATE TRIGGER trg_audit_contract_item_changes AFTER INSERT OR DELETE OR UPDATE ON public.contract_items FOR EACH ROW EXECUTE FUNCTION trg_audit_contract_item_changes();
