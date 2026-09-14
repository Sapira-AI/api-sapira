DROP POLICY IF EXISTS "clients_holding_isolation" ON "public"."clients";

CREATE POLICY "clients_holding_isolation"
ON "public"."clients"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_current_user_holding_id() AS get_current_user_holding_id)));
