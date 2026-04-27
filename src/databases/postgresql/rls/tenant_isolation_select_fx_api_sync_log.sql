DROP POLICY IF EXISTS "tenant_isolation_select_fx_api_sync_log" ON "public"."fx_api_sync_log";

CREATE POLICY "tenant_isolation_select_fx_api_sync_log"
ON "public"."fx_api_sync_log"
AS PERMISSIVE
FOR SELECT
TO public
USING (((holding_id IS NULL) OR (holding_id = get_current_user_holding_id())));
