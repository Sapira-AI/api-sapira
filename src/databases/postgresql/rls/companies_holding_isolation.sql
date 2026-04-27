DROP POLICY IF EXISTS "companies_holding_isolation" ON "public"."companies";

CREATE POLICY "companies_holding_isolation"
ON "public"."companies"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
