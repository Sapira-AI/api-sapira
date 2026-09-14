DROP POLICY IF EXISTS "user_views_delete_own" ON "public"."user_view_preferences";

CREATE POLICY "user_views_delete_own"
ON "public"."user_view_preferences"
AS PERMISSIVE
FOR DELETE
TO public
USING ((user_id = get_current_user_id()));
