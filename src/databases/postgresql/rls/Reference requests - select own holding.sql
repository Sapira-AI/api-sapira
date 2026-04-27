DROP POLICY IF EXISTS "Reference requests - select own holding" ON "public"."reference_requests";

CREATE POLICY "Reference requests - select own holding"
ON "public"."reference_requests"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
