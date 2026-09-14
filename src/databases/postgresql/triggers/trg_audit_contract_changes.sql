DROP TRIGGER IF EXISTS "trg_audit_contract_changes" ON "public"."contracts";

CREATE TRIGGER trg_audit_contract_changes AFTER INSERT OR DELETE OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION trg_audit_contract_changes();
