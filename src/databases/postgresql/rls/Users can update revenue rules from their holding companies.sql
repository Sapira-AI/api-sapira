DROP POLICY IF EXISTS "Users can update revenue rules from their holding companies" ON "public"."revenue_rules";

CREATE POLICY "Users can update revenue rules from their holding companies"
ON "public"."revenue_rules"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((company_id IN ( SELECT c.id
   FROM (companies c
     JOIN user_holdings uh ON ((c.holding_id = uh.holding_id)))
  WHERE (uh.user_id = get_current_user_id()))));
