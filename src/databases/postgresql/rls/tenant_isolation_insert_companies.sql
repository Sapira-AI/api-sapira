DROP POLICY IF EXISTS "tenant_isolation_insert_companies" ON "public"."companies";

CREATE POLICY "tenant_isolation_insert_companies"
ON "public"."companies"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
