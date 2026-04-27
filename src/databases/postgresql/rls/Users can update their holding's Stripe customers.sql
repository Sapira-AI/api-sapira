DROP POLICY IF EXISTS "Users can update their holding's Stripe customers" ON "public"."stripe_customers_stg";

CREATE POLICY "Users can update their holding's Stripe customers"
ON "public"."stripe_customers_stg"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
