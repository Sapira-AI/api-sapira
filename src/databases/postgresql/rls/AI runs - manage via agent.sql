DROP POLICY IF EXISTS "AI runs - manage via agent" ON "public"."ai_runs";

CREATE POLICY "AI runs - manage via agent"
ON "public"."ai_runs"
AS PERMISSIVE
FOR ALL
TO public
USING ((EXISTS ( SELECT 1
   FROM ai_agents a
  WHERE ((a.id = ai_runs.agent_id) AND (a.holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id))))));
