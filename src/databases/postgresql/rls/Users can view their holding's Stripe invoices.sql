DROP POLICY IF EXISTS "Users can view their holding's Stripe invoices" ON "public"."stripe_invoices_stg";

CREATE POLICY "Users can view their holding's Stripe invoices"
ON "public"."stripe_invoices_stg"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
