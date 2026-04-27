DROP POLICY IF EXISTS "AI agent configs - manage via agent" ON "public"."ai_agent_configs";

CREATE POLICY "AI agent configs - manage via agent"
ON "public"."ai_agent_configs"
AS PERMISSIVE
FOR ALL
TO public
USING ((EXISTS ( SELECT 1
   FROM ai_agents a
  WHERE ((a.id = ai_agent_configs.agent_id) AND (a.holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id))))));
