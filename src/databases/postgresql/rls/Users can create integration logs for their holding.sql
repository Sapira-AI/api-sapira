DROP POLICY IF EXISTS "Users can create integration logs for their holding" ON "public"."integration_logs";

CREATE POLICY "Users can create integration logs for their holding"
ON "public"."integration_logs"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
