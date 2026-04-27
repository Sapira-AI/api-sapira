DROP POLICY IF EXISTS "Users can delete their holding's Stripe connections" ON "public"."stripe_connections";

CREATE POLICY "Users can delete their holding's Stripe connections"
ON "public"."stripe_connections"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
