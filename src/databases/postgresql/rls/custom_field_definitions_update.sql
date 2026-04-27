DROP POLICY IF EXISTS "custom_field_definitions_update" ON "public"."custom_field_definitions";

CREATE POLICY "custom_field_definitions_update"
ON "public"."custom_field_definitions"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_user_holding_id()))
WITH CHECK ((holding_id = get_user_holding_id()));
