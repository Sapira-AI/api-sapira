DROP POLICY IF EXISTS "Users can update lifecycle events from their holding contracts" ON "public"."contract_lifecycle_events";

CREATE POLICY "Users can update lifecycle events from their holding contracts"
ON "public"."contract_lifecycle_events"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((contract_id IN ( SELECT c.id
   FROM contracts c
  WHERE (c.holding_id = get_current_user_holding_id()))));
