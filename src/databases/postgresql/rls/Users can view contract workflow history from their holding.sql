DROP POLICY IF EXISTS "Users can view contract workflow history from their holding" ON "public"."contract_workflow_history";

CREATE POLICY "Users can view contract workflow history from their holding"
ON "public"."contract_workflow_history"
AS PERMISSIVE
FOR SELECT
TO public
USING ((contract_id IN ( SELECT c.id
   FROM contracts c
  WHERE (c.holding_id = get_current_user_holding_id()))));
