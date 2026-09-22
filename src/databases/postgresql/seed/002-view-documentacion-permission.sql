-- Permiso INTERNO para el módulo Documentación (front-sapira y sapira-ai).
--
-- Semántica (acordada 21-09, commits 07cf64d en sapira-ai y ce38839 en front-sapira):
-- VIEW_DOCUMENTACION es un permiso interno de Sapira — el comodín ALL_PERMISSIONS de los
-- roles de cliente NO lo cubre. Lo ve un super admin (users.is_super_admin, implícito por
-- código: lib/sapira-permissions.ts y usePermissions.ts), o un rol al que un super admin
-- se lo otorgó explícitamente desde la UI de roles.
--
-- Por eso este seed SOLO registra el permiso en el catálogo (para que un bootstrap desde
-- cero lo tenga y la UI de roles pueda listarlo a super admins). NO lo asigna a ningún rol:
-- el otorgamiento es siempre explícito y de super admin.
INSERT INTO public.permissions (code, description)
VALUES ('VIEW_DOCUMENTACION', 'Ver documentación interna del sistema (permiso interno de Sapira)')
ON CONFLICT (code) DO NOTHING;
