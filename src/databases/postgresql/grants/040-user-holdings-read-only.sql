-- `user_holdings` es de solo lectura para anon y authenticated (M16 `1790870000000-UserHoldingsReadOnlyForClients`): la pertenencia a un
-- holding solo la escriben la API (BYPASSRLS) y las RPC SECURITY DEFINER del front actual, que corren como su dueño.
-- Va después de `000-table-privileges.sql` (GRANT ALL): si ese se re-aplica, este lo vuelve a cerrar.
--
-- ORDEN: aplicar DESPUÉS de la migración M16 (que hace lo mismo); re-aplicarlo converge.

REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_holdings FROM anon, authenticated;
