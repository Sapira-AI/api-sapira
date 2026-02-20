DROP TRIGGER IF EXISTS "trigger_calculate_monthly_avg" ON "public"."exchange_rates";

CREATE TRIGGER "trigger_calculate_monthly_avg"
AFTER INSERT OR UPDATE
ON "public"."exchange_rates"
FOR EACH ROW
EXECUTE FUNCTION "public"."calculate_monthly_avg_fx"();