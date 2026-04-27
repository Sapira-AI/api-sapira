DROP POLICY IF EXISTS "Users can view sellers from their holding" ON "public"."sellers";

CREATE POLICY "Users can view sellers from their holding"
ON "public"."sellers"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
