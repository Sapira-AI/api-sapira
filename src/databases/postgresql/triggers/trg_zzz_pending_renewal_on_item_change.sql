DROP TRIGGER IF EXISTS "trg_zzz_pending_renewal_on_item_change" ON "public"."contract_items";

CREATE TRIGGER "trg_zzz_pending_renewal_on_item_change"
AFTER INSERT OR UPDATE
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION trigger_pending_renewal_on_item_change();
