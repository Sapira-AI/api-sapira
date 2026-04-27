DROP POLICY IF EXISTS "Users can update stripe customers in their holding" ON "public"."stripe_customers_bigquery";

CREATE POLICY "Users can update stripe customers in their holding"
ON "public"."stripe_customers_bigquery"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
