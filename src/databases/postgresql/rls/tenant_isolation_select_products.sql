DROP POLICY IF EXISTS "tenant_isolation_select_products" ON "public"."products";

CREATE POLICY "tenant_isolation_select_products"
ON "public"."products"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
