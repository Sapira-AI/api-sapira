DROP TRIGGER IF EXISTS "update_revenue_schedule_monthly_updated_at" ON "public"."revenue_schedule_monthly";

CREATE TRIGGER "update_revenue_schedule_monthly_updated_at"
BEFORE UPDATE
ON "public"."revenue_schedule_monthly"
FOR EACH ROW
EXECUTE FUNCTION update_revenue_schedule_monthly_updated_at();
