DROP POLICY IF EXISTS "tenant_isolation_update_roles" ON "public"."roles";

CREATE POLICY "tenant_isolation_update_roles"
ON "public"."roles"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
