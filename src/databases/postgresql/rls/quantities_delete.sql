DROP POLICY IF EXISTS "quantities_delete" ON "public"."quantities";

CREATE POLICY "quantities_delete"
ON "public"."quantities"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
