DROP POLICY IF EXISTS "custom_field_definitions_select" ON "public"."custom_field_definitions";

CREATE POLICY "custom_field_definitions_select"
ON "public"."custom_field_definitions"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_user_holding_id()));
