DROP POLICY IF EXISTS "Contact preferences - select own holding" ON "public"."contact_preferences";

CREATE POLICY "Contact preferences - select own holding"
ON "public"."contact_preferences"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_user_holding_id() AS get_user_holding_id)));
