DROP POLICY IF EXISTS "Users can update their contract notifications" ON "public"."contract_notifications";

CREATE POLICY "Users can update their contract notifications"
ON "public"."contract_notifications"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
