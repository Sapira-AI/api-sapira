DROP POLICY IF EXISTS "Users can delete quote stages from their holding" ON "public"."quote_stages";

CREATE POLICY "Users can delete quote stages from their holding"
ON "public"."quote_stages"
AS PERMISSIVE
FOR DELETE
TO public
USING (((holding_id = get_current_user_holding_id()) AND (is_deletable = true)));
