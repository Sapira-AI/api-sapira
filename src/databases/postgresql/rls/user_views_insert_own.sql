DROP POLICY IF EXISTS "user_views_insert_own" ON "public"."user_view_preferences";

CREATE POLICY "user_views_insert_own"
ON "public"."user_view_preferences"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((user_id = get_current_user_id()));
