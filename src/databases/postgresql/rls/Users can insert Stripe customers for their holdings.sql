DROP POLICY IF EXISTS "Users can insert Stripe customers for their holdings" ON "public"."stripe_customers_stg";

CREATE POLICY "Users can insert Stripe customers for their holdings"
ON "public"."stripe_customers_stg"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
