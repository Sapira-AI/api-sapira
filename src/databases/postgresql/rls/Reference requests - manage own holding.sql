DROP POLICY IF EXISTS "Reference requests - manage own holding" ON "public"."reference_requests";

CREATE POLICY "Reference requests - manage own holding"
ON "public"."reference_requests"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
