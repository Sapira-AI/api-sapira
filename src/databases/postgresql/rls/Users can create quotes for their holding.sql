DROP POLICY IF EXISTS "Users can create quotes for their holding" ON "public"."quotes";

CREATE POLICY "Users can create quotes for their holding"
ON "public"."quotes"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
