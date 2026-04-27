DROP POLICY IF EXISTS "Users delete own holding mappings" ON "public"."company_account_mappings";

CREATE POLICY "Users delete own holding mappings"
ON "public"."company_account_mappings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((company_id IN ( SELECT companies.id
   FROM companies
  WHERE (companies.holding_id = ( SELECT companies.holding_id
           FROM users
          WHERE (users.id = auth.uid()))))));
