-- Quita el EXECUTE a PUBLIC de `cleanup_duplicate_partners_by_vat`.
--
-- Originalmente cubría también `cleanup_duplicate_pending_records(integer)`, que la migración
-- `RetiraObjetosDebugMuertos1789040000000` eliminó el 2026-09-10. Su REVOKE se quitó el
-- 2026-09-16: en prod ya había corrido antes del DROP, pero en cualquier base que corra las
-- migraciones primero (QA, un entorno nuevo) este asset fallaba con "function does not exist".
--
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC por defecto, así que estas dos quedaron
-- invocables por `supabase.rpc()` con la anon key —la que viaja en el bundle JavaScript
-- del front—. Medido en producción el 2026-09-14, su ACL era:
--   {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- El `=X/postgres` es PUBLIC con EXECUTE.
--
-- `cleanup_duplicate_partners_by_vat` borra filas de `odoo_partners_stg` de forma
-- irreversible, en lotes, sin escribir en ninguna tabla de log. Hoy un `anon` que la
-- invoque borra 0 filas, pero solo porque la tabla no tiene policy de DELETE: es una
-- mitigación accidental que cualquier policy `FOR ALL` que se agregue mañana desarma.
--
-- Ninguna de las dos tiene callers: ni otra función, ni trigger, ni policy, ni `cron.job`,
-- ni código .ts/.tsx de los dos repos, ni las edge functions del front. Con
-- `track_functions = 'none'` no hay forma de *probar* que nadie las llama — este REVOKE es
-- lo que fabrica esa evidencia: durante la ventana de observación, cualquier caller real
-- se manifiesta como un 42501 en los logs de PostgREST, que se revierte con un GRANT.
--
-- Va como asset y no como migración porque un ACL es estado idempotente, no una
-- transición: es justo lo que un bootstrap desde cero necesita reproducir.
--
-- ⚠️ No es una anomalía de estas dos funciones: el EXECUTE a PUBLIC lo tienen las 315
-- funciones de `public`. Endurecerlo en bloque es un cambio aparte, con su propia prueba
-- (nota: `anon` y `authenticated` tienen el EXECUTE también de forma explícita, así que un
-- REVOKE a PUBLIC no rompería las 64 funciones que el front llama por rpc).

REVOKE ALL ON FUNCTION public.cleanup_duplicate_partners_by_vat(uuid, integer) FROM PUBLIC, anon, authenticated;

-- La que sí borra queda disponible para el service role, que es quien podría necesitarla
-- en una tarea de mantenimiento deliberada.
GRANT EXECUTE ON FUNCTION public.cleanup_duplicate_partners_by_vat(uuid, integer) TO service_role;
