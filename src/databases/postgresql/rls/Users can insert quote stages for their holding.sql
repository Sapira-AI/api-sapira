DROP POLICY IF EXISTS "Users can insert quote stages for their holding" ON "public"."quote_stages";

CREATE POLICY "Users can insert quote stages for their holding"
ON "public"."quote_stages"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
