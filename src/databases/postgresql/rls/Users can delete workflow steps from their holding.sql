DROP POLICY IF EXISTS "Users can delete workflow steps from their holding" ON "public"."workflow_steps";

CREATE POLICY "Users can delete workflow steps from their holding"
ON "public"."workflow_steps"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
