DROP TRIGGER IF EXISTS "trg_set_lifecycle_event_holding_id_ins" ON "public"."contract_lifecycle_events";

CREATE TRIGGER "trg_set_lifecycle_event_holding_id_ins"
BEFORE INSERT
ON "public"."contract_lifecycle_events"
FOR EACH ROW
EXECUTE FUNCTION set_lifecycle_event_holding_id();
