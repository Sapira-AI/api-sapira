-- Quita el EXECUTE de `cron_invoke_edge_function(text, text)` a PUBLIC, `anon` y `authenticated` (OK de Domi 03-10-2026).
--
-- Es SECURITY DEFINER, lee la service role key desde Vault e invoca cualquier edge function con ella. Medido en producción
-- el 03-10-2026, su ACL era:
--   {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- Con la anon key (que viaja en el bundle del front) cualquiera podía invocar cualquier edge function con service role.
--
-- Su único llamador es el job de pg_cron `check-overdue-invoices-daily`, que corre como `postgres`: no se ve afectado.
-- Inventario: `docs/v2-rediseno/switch-supabase-inventario.md`.

REVOKE EXECUTE ON FUNCTION public.cron_invoke_edge_function(text, text) FROM PUBLIC, anon, authenticated;
