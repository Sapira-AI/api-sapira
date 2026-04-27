DROP POLICY IF EXISTS "Users can update workflow steps from their holding" ON "public"."workflow_steps";

CREATE POLICY "Users can update workflow steps from their holding"
ON "public"."workflow_steps"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
