DROP POLICY IF EXISTS "Users can view mappings from their holding" ON "public"."salesforce_object_mappings";

CREATE POLICY "Users can view mappings from their holding"
ON "public"."salesforce_object_mappings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
