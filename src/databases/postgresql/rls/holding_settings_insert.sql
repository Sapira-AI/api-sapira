DROP POLICY IF EXISTS "holding_settings_insert" ON "public"."holding_settings";

CREATE POLICY "holding_settings_insert"
ON "public"."holding_settings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
