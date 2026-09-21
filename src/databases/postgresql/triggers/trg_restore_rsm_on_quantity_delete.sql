DROP TRIGGER IF EXISTS "trg_restore_rsm_on_quantity_delete" ON "public"."quantities";

CREATE TRIGGER trg_restore_rsm_on_quantity_delete AFTER DELETE ON public.quantities FOR EACH ROW EXECUTE FUNCTION restore_rsm_on_quantity_delete();
