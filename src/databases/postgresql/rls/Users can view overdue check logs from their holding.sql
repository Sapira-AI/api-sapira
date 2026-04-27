DROP POLICY IF EXISTS "Users can view overdue check logs from their holding" ON "public"."overdue_check_log";

CREATE POLICY "Users can view overdue check logs from their holding"
ON "public"."overdue_check_log"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (((holding_id = get_current_user_holding_id()) OR (holding_id IS NULL)));
