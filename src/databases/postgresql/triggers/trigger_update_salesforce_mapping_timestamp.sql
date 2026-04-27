DROP TRIGGER IF EXISTS "trigger_update_salesforce_mapping_timestamp" ON "public"."salesforce_object_mappings";

CREATE TRIGGER "trigger_update_salesforce_mapping_timestamp"
BEFORE UPDATE
ON "public"."salesforce_object_mappings"
FOR EACH ROW
EXECUTE FUNCTION update_salesforce_mapping_updated_at();
