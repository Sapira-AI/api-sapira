DROP TRIGGER IF EXISTS "trg_set_lifecycle_event_holding_id_upd" ON "public"."contract_lifecycle_events";

CREATE TRIGGER "trg_set_lifecycle_event_holding_id_upd"
BEFORE UPDATE
ON "public"."contract_lifecycle_events"
FOR EACH ROW
EXECUTE FUNCTION set_lifecycle_event_holding_id();
