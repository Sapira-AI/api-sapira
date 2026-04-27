DROP POLICY IF EXISTS "Users can view quote stages from their holding" ON "public"."quote_stages";

CREATE POLICY "Users can view quote stages from their holding"
ON "public"."quote_stages"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
