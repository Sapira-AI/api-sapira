DROP POLICY IF EXISTS "Users can view mappings from their holding" ON "public"."field_mappings";

CREATE POLICY "Users can view mappings from their holding"
ON "public"."field_mappings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
