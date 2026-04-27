DROP POLICY IF EXISTS "clients_update_access" ON "public"."clients";

CREATE POLICY "clients_update_access"
ON "public"."clients"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((user_has_permission('EDIT_CLIENTES'::text) AND (holding_id = get_current_user_holding_id())))
WITH CHECK ((user_has_permission('EDIT_CLIENTES'::text) AND (holding_id = get_current_user_holding_id())));
