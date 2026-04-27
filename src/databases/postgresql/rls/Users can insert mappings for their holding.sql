DROP POLICY IF EXISTS "Users can insert mappings for their holding" ON "public"."salesforce_object_mappings";

CREATE POLICY "Users can insert mappings for their holding"
ON "public"."salesforce_object_mappings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
