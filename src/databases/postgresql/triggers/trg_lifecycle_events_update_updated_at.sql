DROP TRIGGER IF EXISTS "trg_lifecycle_events_update_updated_at" ON "public"."contract_lifecycle_events";

CREATE TRIGGER "trg_lifecycle_events_update_updated_at"
BEFORE UPDATE
ON "public"."contract_lifecycle_events"
FOR EACH ROW
EXECUTE FUNCTION update_contract_lifecycle_events_updated_at();
