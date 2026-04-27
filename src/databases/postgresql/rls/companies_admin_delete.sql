DROP POLICY IF EXISTS "companies_admin_delete" ON "public"."companies";

CREATE POLICY "companies_admin_delete"
ON "public"."companies"
AS PERMISSIVE
FOR DELETE
TO public
USING ((is_holding_admin() AND (holding_id = get_current_user_holding_id())));
