DROP POLICY IF EXISTS "Users can view stripe customers in their holding" ON "public"."stripe_customers_bigquery";

CREATE POLICY "Users can view stripe customers in their holding"
ON "public"."stripe_customers_bigquery"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
