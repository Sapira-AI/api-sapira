DROP POLICY IF EXISTS "Users can view master data from their holding" ON "public"."master_data";

CREATE POLICY "Users can view master data from their holding"
ON "public"."master_data"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
