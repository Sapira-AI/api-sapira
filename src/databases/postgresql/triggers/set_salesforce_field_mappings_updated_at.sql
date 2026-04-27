DROP TRIGGER IF EXISTS "set_salesforce_field_mappings_updated_at" ON "public"."salesforce_field_mappings";

CREATE TRIGGER "set_salesforce_field_mappings_updated_at"
BEFORE UPDATE
ON "public"."salesforce_field_mappings"
FOR EACH ROW
EXECUTE FUNCTION update_salesforce_field_mappings_updated_at();
