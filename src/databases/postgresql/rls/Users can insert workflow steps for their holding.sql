DROP POLICY IF EXISTS "Users can insert workflow steps for their holding" ON "public"."workflow_steps";

CREATE POLICY "Users can insert workflow steps for their holding"
ON "public"."workflow_steps"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
