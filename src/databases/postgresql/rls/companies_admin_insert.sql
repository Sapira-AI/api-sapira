DROP POLICY IF EXISTS "companies_admin_insert" ON "public"."companies";

CREATE POLICY "companies_admin_insert"
ON "public"."companies"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((is_holding_admin() AND (holding_id = get_current_user_holding_id())));
