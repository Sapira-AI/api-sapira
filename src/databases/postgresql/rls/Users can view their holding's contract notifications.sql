DROP POLICY IF EXISTS "Users can view their holding's contract notifications" ON "public"."contract_notifications";

CREATE POLICY "Users can view their holding's contract notifications"
ON "public"."contract_notifications"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
