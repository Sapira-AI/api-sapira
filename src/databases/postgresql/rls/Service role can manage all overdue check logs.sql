DROP POLICY IF EXISTS "Service role can manage all overdue check logs" ON "public"."overdue_check_log";

CREATE POLICY "Service role can manage all overdue check logs"
ON "public"."overdue_check_log"
AS PERMISSIVE
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
