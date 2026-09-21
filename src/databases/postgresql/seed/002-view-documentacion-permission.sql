-- Permiso para el módulo Documentación (front-sapira). Sin él, el ítem no aparece en el sidebar.
INSERT INTO public.permissions (code, description)
VALUES ('VIEW_DOCUMENTACION', 'Ver documentación interna del sistema')
ON CONFLICT (code) DO NOTHING;

-- Paridad con el acceso previo: roles con VIEW_REPORTES, VIEW_CONFIGURACION o ADMIN_FULL_ACCESS.
INSERT INTO role_permissions (role_id, permission_id, holding_id)
SELECT r.id, p.id, r.holding_id
FROM roles r
JOIN permissions p ON p.code = 'VIEW_DOCUMENTACION'
WHERE EXISTS (
  SELECT 1
  FROM role_permissions rp
  JOIN permissions rp_perm ON rp_perm.id = rp.permission_id
  WHERE rp.role_id = r.id
    AND rp.holding_id = r.holding_id
    AND rp_perm.code IN ('VIEW_REPORTES', 'VIEW_CONFIGURACION', 'ADMIN_FULL_ACCESS')
)
ON CONFLICT DO NOTHING;
