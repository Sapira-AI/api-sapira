DROP POLICY IF EXISTS "Users can insert lifecycle events for their holding contracts" ON "public"."contract_lifecycle_events";

CREATE POLICY "Users can insert lifecycle events for their holding contracts"
ON "public"."contract_lifecycle_events"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((contract_id IN ( SELECT c.id
   FROM contracts c
  WHERE (c.holding_id = get_current_user_holding_id()))) AND (holding_id = get_current_user_holding_id())));
