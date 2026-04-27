DROP POLICY IF EXISTS "AI messages - manage via run" ON "public"."ai_messages";

CREATE POLICY "AI messages - manage via run"
ON "public"."ai_messages"
AS PERMISSIVE
FOR ALL
TO public
USING ((EXISTS ( SELECT 1
   FROM (ai_runs r
     JOIN ai_agents a ON ((a.id = r.agent_id)))
  WHERE ((r.id = ai_messages.run_id) AND (a.holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id))))));
