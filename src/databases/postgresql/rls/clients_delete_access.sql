DROP POLICY IF EXISTS "clients_delete_access" ON "public"."clients";

CREATE POLICY "clients_delete_access"
ON "public"."clients"
AS PERMISSIVE
FOR DELETE
TO public
USING ((is_holding_admin() AND (holding_id = get_current_user_holding_id())));
