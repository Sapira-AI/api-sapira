DROP POLICY IF EXISTS "Users can insert contract notifications for their holding" ON "public"."contract_notifications";

CREATE POLICY "Users can insert contract notifications for their holding"
ON "public"."contract_notifications"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
