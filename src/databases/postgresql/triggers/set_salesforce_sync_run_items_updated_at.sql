DROP TRIGGER IF EXISTS "set_salesforce_sync_run_items_updated_at" ON "public"."salesforce_sync_run_items";

CREATE TRIGGER set_salesforce_sync_run_items_updated_at BEFORE UPDATE ON public.salesforce_sync_run_items FOR EACH ROW EXECUTE FUNCTION update_salesforce_staging_updated_at();
