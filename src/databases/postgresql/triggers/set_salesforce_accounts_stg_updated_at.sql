DROP TRIGGER IF EXISTS "set_salesforce_accounts_stg_updated_at" ON "public"."salesforce_accounts_stg";

CREATE TRIGGER set_salesforce_accounts_stg_updated_at BEFORE UPDATE ON public.salesforce_accounts_stg FOR EACH ROW EXECUTE FUNCTION update_salesforce_staging_updated_at();
