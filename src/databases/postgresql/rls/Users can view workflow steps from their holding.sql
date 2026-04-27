DROP POLICY IF EXISTS "Users can view workflow steps from their holding" ON "public"."workflow_steps";

CREATE POLICY "Users can view workflow steps from their holding"
ON "public"."workflow_steps"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
