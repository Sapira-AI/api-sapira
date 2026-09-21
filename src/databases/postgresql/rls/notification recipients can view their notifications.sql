DROP POLICY IF EXISTS "notification recipients can view their notifications" ON "public"."app_notifications";

CREATE POLICY "notification recipients can view their notifications"
ON "public"."app_notifications"
AS PERMISSIVE
FOR SELECT
TO public
USING ((EXISTS ( SELECT 1
   FROM app_notification_recipients recipient
  WHERE ((recipient.notification_id = recipient.id) AND (recipient.user_id = get_current_user_id())))));
