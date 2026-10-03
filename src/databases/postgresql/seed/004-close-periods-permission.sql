-- M4 · Configuración v2 (D2): permiso CLOSE_PERIODS "Cerrar y reabrir períodos contables".
--
-- 1. Registra el código en el catálogo.
-- 2. Lo asigna a los roles por defecto Administrador y Finanzas de TODOS los holdings existentes (idempotente:
--    NOT EXISTS). Los holdings nuevos lo reciben por functions/create_default_roles_for_holding.sql.
--
-- Administrador ya pasa hoy por ALL_PERMISSIONS (lo tienen los 7 holdings); la fila explícita deja el permiso
-- visible en la matriz de roles. Finanzas no tenía forma de cerrar períodos (antes: solo is_holding_admin()).
--
-- Orden: este seed ANTES de re-aplicar la función (la función filtra WHERE code IN (...) contra permissions).
-- NO APLICADO al 02-10.
INSERT INTO public.permissions (code, description)
VALUES ('CLOSE_PERIODS', 'Cerrar y reabrir períodos contables')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id, holding_id)
SELECT r.id, p.id, r.holding_id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE p.code = 'CLOSE_PERIODS'
  AND r.holding_id IS NOT NULL
  AND r.name IN ('Administrador', 'Finanzas')
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
