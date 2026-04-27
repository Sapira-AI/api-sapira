DROP POLICY IF EXISTS "Users can delete odoo mappings from their holding" ON "public"."odoo_object_mappings";

CREATE POLICY "Users can delete odoo mappings from their holding"
ON "public"."odoo_object_mappings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
