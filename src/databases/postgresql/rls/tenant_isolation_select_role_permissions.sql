DROP POLICY IF EXISTS "tenant_isolation_select_role_permissions" ON "public"."role_permissions";

CREATE POLICY "tenant_isolation_select_role_permissions"
ON "public"."role_permissions"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
