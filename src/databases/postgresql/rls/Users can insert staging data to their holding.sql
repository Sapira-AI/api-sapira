DROP POLICY IF EXISTS "Users can insert staging data to their holding" ON "public"."odoo_partners_stg";

CREATE POLICY "Users can insert staging data to their holding"
ON "public"."odoo_partners_stg"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
