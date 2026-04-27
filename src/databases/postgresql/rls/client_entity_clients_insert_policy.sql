DROP POLICY IF EXISTS "client_entity_clients_insert_policy" ON "public"."client_entity_clients";

CREATE POLICY "client_entity_clients_insert_policy"
ON "public"."client_entity_clients"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
