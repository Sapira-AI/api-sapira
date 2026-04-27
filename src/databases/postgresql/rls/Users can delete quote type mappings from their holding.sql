DROP POLICY IF EXISTS "Users can delete quote type mappings from their holding" ON "public"."salesforce_quote_type_mappings";

CREATE POLICY "Users can delete quote type mappings from their holding"
ON "public"."salesforce_quote_type_mappings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
