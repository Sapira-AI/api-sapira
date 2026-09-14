-- Permisos por rol. En producción las 132 tablas comparten una única firma:
-- ALL PRIVILEGES para anon, authenticated, postgres y service_role, así que la
-- contención real la hace RLS, no el GRANT. (Firmas distintas medidas: 1.)
--
-- GRANT y RLS son capas independientes: sin el GRANT la policy nunca se evalúa y el
-- error es `permission denied`, no "0 filas". Sin este asset, un entorno levantado
-- desde cero tendría tablas correctas e inaccesibles para el front.

GRANT ALL ON ALL TABLES IN SCHEMA "public" TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "public" TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA "public" TO anon, authenticated, service_role;

-- Para que las tablas creadas después hereden los mismos permisos.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
