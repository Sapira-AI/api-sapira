DROP POLICY IF EXISTS "tenant_isolation_insert_roles" ON "public"."roles";

CREATE POLICY "tenant_isolation_insert_roles"
ON "public"."roles"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
