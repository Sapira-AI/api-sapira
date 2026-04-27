DROP POLICY IF EXISTS "contracts_delete_access" ON "public"."contracts";

CREATE POLICY "contracts_delete_access"
ON "public"."contracts"
AS PERMISSIVE
FOR DELETE
TO public
USING ((is_holding_admin() AND (holding_id = get_current_user_holding_id())));
