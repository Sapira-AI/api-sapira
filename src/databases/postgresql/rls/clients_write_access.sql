DROP POLICY IF EXISTS "clients_write_access" ON "public"."clients";

CREATE POLICY "clients_write_access"
ON "public"."clients"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((user_has_permission('EDIT_CLIENTES'::text) AND (holding_id = get_current_user_holding_id())));
