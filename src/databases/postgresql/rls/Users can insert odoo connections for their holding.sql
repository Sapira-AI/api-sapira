DROP POLICY IF EXISTS "Users can insert odoo connections for their holding" ON "public"."odoo_connections";

CREATE POLICY "Users can insert odoo connections for their holding"
ON "public"."odoo_connections"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
