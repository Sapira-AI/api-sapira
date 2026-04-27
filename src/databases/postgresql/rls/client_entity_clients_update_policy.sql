DROP POLICY IF EXISTS "client_entity_clients_update_policy" ON "public"."client_entity_clients";

CREATE POLICY "client_entity_clients_update_policy"
ON "public"."client_entity_clients"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
