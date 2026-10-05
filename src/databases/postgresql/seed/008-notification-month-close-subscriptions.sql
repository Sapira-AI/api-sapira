-- N8 · Notificaciones v2 fase 2 (`docs/v2-rediseno/contrato-api-notificaciones.md` §8.6): suscripciones por defecto del tipo nuevo
-- `month_close_pending` (facturas del mes sin emitir) para Administrador, Finanzas y Facturación y Cobranza de TODOS los holdings.
-- Espejo de `defaultSubscriptions()` del catálogo junto con 007 (un test compara 007 + 008 con el catálogo).
--
-- Idempotente y aditivo (NOT EXISTS): no pisa lo que un holding ya configuró; no borra nada. Los holdings nuevos las reciben por
-- functions/create_default_roles_for_holding.sql. NO APLICADO al 03-10.
WITH defaults(notification_type, role_name) AS (
  VALUES
    ('month_close_pending', 'Administrador'),
    ('month_close_pending', 'Finanzas'),
    ('month_close_pending', 'Facturación y Cobranza')
)
INSERT INTO public.notification_role_subscriptions (holding_id, role_id, notification_type)
SELECT r.holding_id, r.id, d.notification_type
FROM defaults d
JOIN public.roles r ON r.name = d.role_name AND r.is_default = true AND r.holding_id IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.notification_role_subscriptions s
  WHERE s.holding_id = r.holding_id AND s.role_id = r.id AND s.notification_type = d.notification_type
);
