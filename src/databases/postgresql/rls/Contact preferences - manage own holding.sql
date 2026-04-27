DROP POLICY IF EXISTS "Contact preferences - manage own holding" ON "public"."contact_preferences";

CREATE POLICY "Contact preferences - manage own holding"
ON "public"."contact_preferences"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
