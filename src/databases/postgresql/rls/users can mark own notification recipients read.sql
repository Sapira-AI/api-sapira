DROP POLICY IF EXISTS "users can mark own notification recipients read" ON "public"."app_notification_recipients";

CREATE POLICY "users can mark own notification recipients read"
ON "public"."app_notification_recipients"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((user_id = get_current_user_id()))
WITH CHECK ((user_id = get_current_user_id()));
