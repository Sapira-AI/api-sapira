DROP POLICY IF EXISTS "holding_integration_settings_service_role" ON "public"."holding_integration_settings";

CREATE POLICY "holding_integration_settings_service_role"
ON "public"."holding_integration_settings"
AS PERMISSIVE
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
