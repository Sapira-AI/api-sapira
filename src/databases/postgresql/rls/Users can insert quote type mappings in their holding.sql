DROP POLICY IF EXISTS "Users can insert quote type mappings in their holding" ON "public"."salesforce_quote_type_mappings";

CREATE POLICY "Users can insert quote type mappings in their holding"
ON "public"."salesforce_quote_type_mappings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
