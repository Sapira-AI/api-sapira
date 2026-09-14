DROP TRIGGER IF EXISTS "set_salesforce_sync_runs_updated_at" ON "public"."salesforce_sync_runs";

CREATE TRIGGER set_salesforce_sync_runs_updated_at BEFORE UPDATE ON public.salesforce_sync_runs FOR EACH ROW EXECUTE FUNCTION update_salesforce_staging_updated_at();
