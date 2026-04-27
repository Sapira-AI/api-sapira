DROP TRIGGER IF EXISTS "set_updated_at_on_contract_lifecycle_events" ON "public"."contract_lifecycle_events";

CREATE TRIGGER "set_updated_at_on_contract_lifecycle_events"
BEFORE UPDATE
ON "public"."contract_lifecycle_events"
FOR EACH ROW
EXECUTE FUNCTION update_contract_lifecycle_events_updated_at();
