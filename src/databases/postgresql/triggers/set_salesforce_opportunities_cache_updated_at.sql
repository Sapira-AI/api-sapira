DROP TRIGGER IF EXISTS "set_salesforce_opportunities_cache_updated_at" ON "public"."salesforce_opportunities_cache";

CREATE TRIGGER "set_salesforce_opportunities_cache_updated_at"
BEFORE UPDATE
ON "public"."salesforce_opportunities_cache"
FOR EACH ROW
EXECUTE FUNCTION update_salesforce_opportunities_cache_updated_at();
