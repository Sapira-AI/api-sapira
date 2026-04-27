DROP POLICY IF EXISTS "Users can update odoo connections in their holding" ON "public"."odoo_connections";

CREATE POLICY "Users can update odoo connections in their holding"
ON "public"."odoo_connections"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
