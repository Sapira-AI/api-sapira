DROP POLICY IF EXISTS "AI agents - manage own holding" ON "public"."ai_agents";

CREATE POLICY "AI agents - manage own holding"
ON "public"."ai_agents"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
