DROP POLICY IF EXISTS "Users can view sync logs from their holding" ON "public"."salesforce_sync_logs";

CREATE POLICY "Users can view sync logs from their holding"
ON "public"."salesforce_sync_logs"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
