DROP POLICY IF EXISTS "Users can delete odoo connections in their holding" ON "public"."odoo_connections";

CREATE POLICY "Users can delete odoo connections in their holding"
ON "public"."odoo_connections"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
