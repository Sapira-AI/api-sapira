DROP POLICY IF EXISTS "Users can update sellers from their holding" ON "public"."sellers";

CREATE POLICY "Users can update sellers from their holding"
ON "public"."sellers"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
