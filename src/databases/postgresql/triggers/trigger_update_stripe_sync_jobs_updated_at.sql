DROP TRIGGER IF EXISTS "trigger_update_stripe_sync_jobs_updated_at" ON "public"."stripe_sync_jobs";

CREATE TRIGGER "trigger_update_stripe_sync_jobs_updated_at"
BEFORE UPDATE
ON "public"."stripe_sync_jobs"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_sync_jobs_updated_at();
