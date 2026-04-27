DROP POLICY IF EXISTS "tenant_isolation_insert_products" ON "public"."products";

CREATE POLICY "tenant_isolation_insert_products"
ON "public"."products"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
