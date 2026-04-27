DROP POLICY IF EXISTS "quantities_update" ON "public"."quantities";

CREATE POLICY "quantities_update"
ON "public"."quantities"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
