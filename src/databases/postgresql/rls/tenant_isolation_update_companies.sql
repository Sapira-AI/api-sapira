DROP POLICY IF EXISTS "tenant_isolation_update_companies" ON "public"."companies";

CREATE POLICY "tenant_isolation_update_companies"
ON "public"."companies"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
