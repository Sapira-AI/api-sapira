DROP POLICY IF EXISTS "contracts_manage_access" ON "public"."contracts";

CREATE POLICY "contracts_manage_access"
ON "public"."contracts"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((user_has_permission('EDIT_CONTRATOS'::text) AND (holding_id = get_current_user_holding_id())));
