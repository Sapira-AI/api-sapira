DROP POLICY IF EXISTS "Users can insert sellers for their holding" ON "public"."sellers";

CREATE POLICY "Users can insert sellers for their holding"
ON "public"."sellers"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
