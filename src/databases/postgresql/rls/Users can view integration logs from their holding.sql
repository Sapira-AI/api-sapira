DROP POLICY IF EXISTS "Users can view integration logs from their holding" ON "public"."integration_logs";

CREATE POLICY "Users can view integration logs from their holding"
ON "public"."integration_logs"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
