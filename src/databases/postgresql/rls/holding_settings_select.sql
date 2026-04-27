DROP POLICY IF EXISTS "holding_settings_select" ON "public"."holding_settings";

CREATE POLICY "holding_settings_select"
ON "public"."holding_settings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
