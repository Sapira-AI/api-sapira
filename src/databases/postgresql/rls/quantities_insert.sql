DROP POLICY IF EXISTS "quantities_insert" ON "public"."quantities";

CREATE POLICY "quantities_insert"
ON "public"."quantities"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
