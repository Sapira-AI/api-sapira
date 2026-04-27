DROP POLICY IF EXISTS "Users can delete stripe customers in their holding" ON "public"."stripe_customers_bigquery";

CREATE POLICY "Users can delete stripe customers in their holding"
ON "public"."stripe_customers_bigquery"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
