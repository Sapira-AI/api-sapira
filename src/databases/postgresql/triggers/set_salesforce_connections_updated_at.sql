DROP TRIGGER IF EXISTS "set_salesforce_connections_updated_at" ON "public"."salesforce_connections";

CREATE TRIGGER "set_salesforce_connections_updated_at"
BEFORE UPDATE
ON "public"."salesforce_connections"
FOR EACH ROW
EXECUTE FUNCTION update_salesforce_connections_updated_at();
