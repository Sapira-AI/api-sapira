DROP POLICY IF EXISTS "exchange_rates_select_authenticated" ON "public"."exchange_rates";

CREATE POLICY "exchange_rates_select_authenticated"
ON "public"."exchange_rates"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
