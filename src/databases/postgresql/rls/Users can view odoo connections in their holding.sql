DROP POLICY IF EXISTS "Users can view odoo connections in their holding" ON "public"."odoo_connections";

CREATE POLICY "Users can view odoo connections in their holding"
ON "public"."odoo_connections"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
