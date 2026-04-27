DROP POLICY IF EXISTS "exchange_rates_monthly_avg_select_authenticated" ON "public"."exchange_rates_monthly_avg";

CREATE POLICY "exchange_rates_monthly_avg_select_authenticated"
ON "public"."exchange_rates_monthly_avg"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
