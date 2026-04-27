DROP POLICY IF EXISTS "AI agents - select own holding" ON "public"."ai_agents";

CREATE POLICY "AI agents - select own holding"
ON "public"."ai_agents"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
