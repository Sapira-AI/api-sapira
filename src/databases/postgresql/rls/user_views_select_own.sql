DROP POLICY IF EXISTS "user_views_select_own" ON "public"."user_view_preferences";

CREATE POLICY "user_views_select_own"
ON "public"."user_view_preferences"
AS PERMISSIVE
FOR SELECT
TO public
USING ((user_id = get_current_user_id()));
