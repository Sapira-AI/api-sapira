DROP TRIGGER IF EXISTS "trg_sync_client_entity_primary_client" ON "public"."client_entity_clients";

CREATE TRIGGER "trg_sync_client_entity_primary_client"
AFTER DELETE OR INSERT OR UPDATE
ON "public"."client_entity_clients"
FOR EACH ROW
EXECUTE FUNCTION sync_client_entity_primary_client();
