DROP POLICY IF EXISTS "Users can delete mappings from their holding" ON "public"."salesforce_object_mappings";

CREATE POLICY "Users can delete mappings from their holding"
ON "public"."salesforce_object_mappings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
