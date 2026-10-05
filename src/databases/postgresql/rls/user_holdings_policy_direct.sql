-- Solo lectura desde M16 (`1790870000000-UserHoldingsReadOnlyForClients`): antes era FOR ALL sin WITH CHECK y permitía a un usuario
-- insertarse en otro holding o reactivar su acceso. Las escrituras van por la API o por RPC SECURITY DEFINER.
DROP POLICY IF EXISTS "user_holdings_policy_direct" ON "public"."user_holdings";

CREATE POLICY "user_holdings_policy_direct"
ON "public"."user_holdings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((user_id = get_current_user_id()));
