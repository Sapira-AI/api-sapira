-- N3 · Notificaciones v2 (D3 + ajustes de Domi 03-10, `docs/v2-rediseno/contrato-api-notificaciones.md` §1): suscripciones por defecto por rol.
-- Espejo de `defaultSubscriptions()` de `src/modules/notifications/notification-catalog.ts` (un test compara ambos).
--
-- - Administrador: todo, salvo los correos internos de Sapira (tasa de respaldo, tasa faltante, resumen de errores: solo super admins).
-- - Finanzas: ERP, renovaciones (propuesta y vencimiento), pactos y almacén de datos.
-- - Facturación y Cobranza: ERP y almacén de datos.
-- - Ventas y Operaciones: cotización del CRM detenida.
-- - Fallas de sincronización (CRM y tipos de cambio): Administrador + Admin Técnico + super admins (role_id NULL).
--
-- Roles por defecto por nombre (`roles.is_default = true`, M9) de TODOS los holdings. Idempotente y aditivo: no inserta si ya existe una
-- fila del rol y tipo (habilitada o no), así no pisa lo que un holding ya configuró; no borra nada.
-- Requiere: migración RolesIsDefault1790800000000 (ya aplicada en producción). Los holdings nuevos las reciben por
-- functions/create_default_roles_for_holding.sql. NO APLICADO al 03-10.
WITH defaults(notification_type, role_name) AS (
  VALUES
    ('invoice_odoo_failure', 'Administrador'),
    ('invoice_odoo_failure', 'Finanzas'),
    ('invoice_odoo_failure', 'Facturación y Cobranza'),
    ('salesforce_staging_blocked', 'Administrador'),
    ('salesforce_staging_blocked', 'Ventas'),
    ('salesforce_staging_blocked', 'Operaciones'),
    ('salesforce_sync_failure', 'Administrador'),
    ('salesforce_sync_failure', 'Admin Técnico'),
    ('contract_renewal_proposed', 'Administrador'),
    ('contract_renewal_proposed', 'Finanzas'),
    ('contract_renewal_reminder', 'Administrador'),
    ('contract_renewal_reminder', 'Finanzas'),
    ('contract_scheduled_change_due', 'Administrador'),
    ('contract_scheduled_change_due', 'Finanzas'),
    ('bigquery_quantities_diff', 'Administrador'),
    ('bigquery_quantities_diff', 'Finanzas'),
    ('bigquery_quantities_diff', 'Facturación y Cobranza'),
    ('bigquery_quantities_unmapped', 'Administrador'),
    ('bigquery_quantities_unmapped', 'Finanzas'),
    ('bigquery_quantities_unmapped', 'Facturación y Cobranza'),
    ('bigquery_quantities_blocked', 'Administrador'),
    ('bigquery_quantities_blocked', 'Finanzas'),
    ('bigquery_quantities_blocked', 'Facturación y Cobranza'),
    ('bigquery_quantities_currency_mismatch', 'Administrador'),
    ('bigquery_quantities_currency_mismatch', 'Finanzas'),
    ('bigquery_quantities_currency_mismatch', 'Facturación y Cobranza'),
    ('fx_sync_failure', 'Administrador'),
    ('fx_sync_failure', 'Admin Técnico')
)
INSERT INTO public.notification_role_subscriptions (holding_id, role_id, notification_type)
SELECT r.holding_id, r.id, d.notification_type
FROM defaults d
JOIN public.roles r ON r.name = d.role_name AND r.is_default = true AND r.holding_id IS NOT NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.notification_role_subscriptions s
  WHERE s.holding_id = r.holding_id AND s.role_id = r.id AND s.notification_type = d.notification_type
);

-- Super admins (role_id NULL; el UNIQUE no cubre NULL, por eso el NOT EXISTS).
WITH super_admin_types(notification_type) AS (
  VALUES ('salesforce_sync_failure'), ('fx_sync_failure'), ('invoice_fx_fallback'), ('invoice_fx_missing'), ('scheduler_error_summary')
)
INSERT INTO public.notification_role_subscriptions (holding_id, role_id, notification_type)
SELECT h.id, NULL, t.notification_type
FROM super_admin_types t
CROSS JOIN public.company_holdings h
WHERE NOT EXISTS (
  SELECT 1 FROM public.notification_role_subscriptions s
  WHERE s.holding_id = h.id AND s.role_id IS NULL AND s.notification_type = t.notification_type
);
