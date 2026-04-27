DROP POLICY IF EXISTS "Users can update mappings from their holding" ON "public"."salesforce_object_mappings";

CREATE POLICY "Users can update mappings from their holding"
ON "public"."salesforce_object_mappings"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
