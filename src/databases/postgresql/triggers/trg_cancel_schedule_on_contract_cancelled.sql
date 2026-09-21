DROP TRIGGER IF EXISTS "trg_cancel_schedule_on_contract_cancelled" ON "public"."contracts";

CREATE TRIGGER trg_cancel_schedule_on_contract_cancelled AFTER UPDATE OF status ON public.contracts FOR EACH ROW WHEN (((new.status = 'Cancelado'::text) AND (old.status IS DISTINCT FROM 'Cancelado'::text))) EXECUTE FUNCTION cancel_contract_invoices_on_contract_cancelled();
