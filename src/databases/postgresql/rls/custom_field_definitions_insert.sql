DROP POLICY IF EXISTS "custom_field_definitions_insert" ON "public"."custom_field_definitions";

CREATE POLICY "custom_field_definitions_insert"
ON "public"."custom_field_definitions"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_user_holding_id()));
