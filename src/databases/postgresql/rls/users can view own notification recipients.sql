DROP POLICY IF EXISTS "users can view own notification recipients" ON "public"."app_notification_recipients";

CREATE POLICY "users can view own notification recipients"
ON "public"."app_notification_recipients"
AS PERMISSIVE
FOR SELECT
TO public
USING ((user_id = get_current_user_id()));
