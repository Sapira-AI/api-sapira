DROP POLICY IF EXISTS "holding_settings_delete" ON "public"."holding_settings";

CREATE POLICY "holding_settings_delete"
ON "public"."holding_settings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
