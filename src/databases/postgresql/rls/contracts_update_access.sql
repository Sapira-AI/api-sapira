DROP POLICY IF EXISTS "contracts_update_access" ON "public"."contracts";

CREATE POLICY "contracts_update_access"
ON "public"."contracts"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((user_has_permission('EDIT_CONTRATOS'::text) AND (holding_id = get_current_user_holding_id())))
WITH CHECK ((user_has_permission('EDIT_CONTRATOS'::text) AND (holding_id = get_current_user_holding_id())));
