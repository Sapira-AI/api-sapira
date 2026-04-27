DROP POLICY IF EXISTS "quantities_select" ON "public"."quantities";

CREATE POLICY "quantities_select"
ON "public"."quantities"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
