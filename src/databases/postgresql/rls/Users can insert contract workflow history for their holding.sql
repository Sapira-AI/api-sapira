DROP POLICY IF EXISTS "Users can insert contract workflow history for their holding" ON "public"."contract_workflow_history";

CREATE POLICY "Users can insert contract workflow history for their holding"
ON "public"."contract_workflow_history"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((contract_id IN ( SELECT c.id
   FROM contracts c
  WHERE (c.holding_id = get_current_user_holding_id()))));
