DROP POLICY IF EXISTS "Users can insert stripe customers for their holding" ON "public"."stripe_customers_bigquery";

CREATE POLICY "Users can insert stripe customers for their holding"
ON "public"."stripe_customers_bigquery"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
