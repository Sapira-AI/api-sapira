DROP POLICY IF EXISTS "Users can delete client agent configs of their holding" ON "public"."client_agent_configs";

CREATE POLICY "Users can delete client agent configs of their holding"
ON "public"."client_agent_configs"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
