DROP POLICY IF EXISTS "Users can view odoo mappings from their holding" ON "public"."odoo_object_mappings";

CREATE POLICY "Users can view odoo mappings from their holding"
ON "public"."odoo_object_mappings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
