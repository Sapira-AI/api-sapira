DROP TRIGGER IF EXISTS "trigger_update_monthly_avg" ON "public"."exchange_rates";

CREATE TRIGGER "trigger_update_monthly_avg"
AFTER INSERT OR UPDATE
ON "public"."exchange_rates"
FOR EACH ROW
EXECUTE FUNCTION "public"."update_monthly_avg_on_rate_change"();