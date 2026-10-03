-- Configuración v2 (decisión de Domi, 03-10): el rol por defecto Finanzas puede ENTRAR a Configuración (VIEW_CONFIGURACION).
-- Lo necesita para ver la Compañía 360 y cerrar períodos (CLOSE_PERIODS, seed 004) sin poder editar la configuración.
--
-- Asigna VIEW_CONFIGURACION al rol por defecto Finanzas (is_default = true, M9) de TODOS los holdings existentes.
-- Idempotente (NOT EXISTS). Los holdings nuevos lo reciben por functions/create_default_roles_for_holding.sql.
-- Requiere: migración RolesIsDefault1790800000000 (columna roles.is_default).
-- NO APLICADO al 03-10.
INSERT INTO public.role_permissions (role_id, permission_id, holding_id)
SELECT r.id, p.id, r.holding_id
FROM public.roles r
JOIN public.permissions p ON p.code = 'VIEW_CONFIGURACION'
WHERE r.holding_id IS NOT NULL
  AND r.is_default = true
  AND r.name = 'Finanzas'
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
