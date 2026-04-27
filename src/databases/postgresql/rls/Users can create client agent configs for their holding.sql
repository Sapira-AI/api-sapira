DROP POLICY IF EXISTS "Users can create client agent configs for their holding" ON "public"."client_agent_configs";

CREATE POLICY "Users can create client agent configs for their holding"
ON "public"."client_agent_configs"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
