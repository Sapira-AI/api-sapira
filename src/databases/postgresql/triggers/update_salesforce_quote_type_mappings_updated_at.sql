DROP TRIGGER IF EXISTS "update_salesforce_quote_type_mappings_updated_at" ON "public"."salesforce_quote_type_mappings";

CREATE TRIGGER "update_salesforce_quote_type_mappings_updated_at"
BEFORE UPDATE
ON "public"."salesforce_quote_type_mappings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
