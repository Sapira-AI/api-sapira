DROP POLICY IF EXISTS "client_activity_notes_service_role" ON "public"."client_activity_notes";

CREATE POLICY "client_activity_notes_service_role"
ON "public"."client_activity_notes"
AS PERMISSIVE
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
