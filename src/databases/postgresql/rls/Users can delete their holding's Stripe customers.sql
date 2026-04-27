DROP POLICY IF EXISTS "Users can delete their holding's Stripe customers" ON "public"."stripe_customers_stg";

CREATE POLICY "Users can delete their holding's Stripe customers"
ON "public"."stripe_customers_stg"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
