CREATE OR REPLACE FUNCTION public.create_default_roles_for_holding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_admin_role_id UUID;
  v_invitado_role_id UUID;
  v_ventas_role_id UUID;
  v_operaciones_role_id UUID;
  v_revenue_ops_role_id UUID;
  v_bi_role_id UUID;
  v_facturacion_role_id UUID;
  v_finanzas_role_id UUID;
  v_admin_negocio_role_id UUID;
  v_admin_tecnico_role_id UUID;
BEGIN
  -- Insertar los 10 roles por defecto asociados al nuevo holding y capturar sus IDs
  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Administrador', 'Acceso completo al sistema', NEW.id, NOW())
  RETURNING id INTO v_admin_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Invitado', 'Acceso mínimo, solo vistas generales', NEW.id, NOW())
  RETURNING id INTO v_invitado_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Ventas', 'Lectura de módulos comerciales', NEW.id, NOW())
  RETURNING id INTO v_ventas_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Operaciones', 'Gestión operativa', NEW.id, NOW())
  RETURNING id INTO v_operaciones_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Revenue Ops', 'Lectura de revenue y contratos', NEW.id, NOW())
  RETURNING id INTO v_revenue_ops_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('BI', 'Análisis de datos', NEW.id, NOW())
  RETURNING id INTO v_bi_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Facturación y Cobranza', 'Gestión de facturación y cobranzas', NEW.id, NOW())
  RETURNING id INTO v_facturacion_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Finanzas', 'Control financiero completo sin configuración', NEW.id, NOW())
  RETURNING id INTO v_finanzas_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Admin de Negocio', 'Administración funcional de negocio', NEW.id, NOW())
  RETURNING id INTO v_admin_negocio_role_id;

  INSERT INTO roles (name, description, holding_id, created_at)
  VALUES
    ('Admin Técnico', 'Administración técnica (IA, integraciones)', NEW.id, NOW())
  RETURNING id INTO v_admin_tecnico_role_id;

  -- Insertar permisos para Administrador (todos los permisos)
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_admin_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'EDIT_DASHBOARD',
    'VIEW_CLIENTES', 'EDIT_CLIENTES',
    'VIEW_COTIZACIONES', 'EDIT_COTIZACIONES',
    'VIEW_CONTRATOS', 'EDIT_CONTRATOS',
    'VIEW_FACTURACION', 'EDIT_FACTURACION',
    'VIEW_REVENUE', 'EDIT_REVENUE',
    'VIEW_REPORTES',
    'VIEW_AGENTES_IA', 'EDIT_AGENTES_IA',
    'VIEW_INTEGRACIONES', 'EDIT_INTEGRACIONES',
    'VIEW_CONFIGURACION', 'EDIT_CONFIGURACION',
    'ADMIN_FULL_ACCESS'
  );

  -- Insertar permisos para Invitado
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_invitado_role_id, id, NEW.id
  FROM permissions
  WHERE code IN ('VIEW_DASHBOARD', 'VIEW_REPORTES');

  -- Insertar permisos para Ventas
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_ventas_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'VIEW_CLIENTES', 'VIEW_COTIZACIONES', 'VIEW_CONTRATOS'
  );

  -- Insertar permisos para Operaciones
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_operaciones_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'VIEW_CLIENTES', 'EDIT_COTIZACIONES',
    'VIEW_CONTRATOS', 'VIEW_FACTURACION', 'VIEW_REPORTES'
  );

  -- Insertar permisos para Revenue Ops
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_revenue_ops_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'VIEW_CLIENTES', 'VIEW_COTIZACIONES',
    'VIEW_CONTRATOS', 'VIEW_REVENUE', 'VIEW_REPORTES'
  );

  -- Insertar permisos para BI
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_bi_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'VIEW_CLIENTES', 'VIEW_FACTURACION',
    'VIEW_REVENUE', 'VIEW_REPORTES'
  );

  -- Insertar permisos para Facturación y Cobranza
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_facturacion_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'VIEW_DASHBOARD', 'VIEW_CLIENTES', 'VIEW_FACTURACION',
    'EDIT_FACTURACION', 'VIEW_REPORTES'
  );

  -- Insertar permisos para Finanzas
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_finanzas_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'EDIT_DASHBOARD', 'VIEW_DASHBOARD', 'VIEW_CLIENTES',
    'EDIT_COTIZACIONES', 'VIEW_COTIZACIONES', 'EDIT_CONTRATOS',
    'VIEW_CONTRATOS', 'VIEW_FACTURACION', 'EDIT_FACTURACION',
    'VIEW_REVENUE', 'EDIT_REVENUE', 'VIEW_REPORTES',
    'VIEW_AGENTES_IA', 'VIEW_INTEGRACIONES', 'EDIT_INTEGRACIONES'
  );

  -- Insertar permisos para Admin de Negocio
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_admin_negocio_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'EDIT_DASHBOARD', 'VIEW_DASHBOARD', 'EDIT_CLIENTES', 'VIEW_CLIENTES',
    'EDIT_COTIZACIONES', 'VIEW_COTIZACIONES', 'EDIT_CONTRATOS', 'VIEW_CONTRATOS',
    'VIEW_FACTURACION', 'EDIT_FACTURACION', 'VIEW_REVENUE', 'EDIT_REVENUE',
    'VIEW_REPORTES', 'VIEW_AGENTES_IA', 'VIEW_INTEGRACIONES',
    'VIEW_CONFIGURACION', 'EDIT_CONFIGURACION'
  );

  -- Insertar permisos para Admin Técnico
  INSERT INTO role_permissions (role_id, permission_id, holding_id)
  SELECT v_admin_tecnico_role_id, id, NEW.id
  FROM permissions
  WHERE code IN (
    'EDIT_DASHBOARD', 'VIEW_DASHBOARD', 'VIEW_CLIENTES',
    'VIEW_COTIZACIONES', 'VIEW_CONTRATOS', 'VIEW_FACTURACION',
    'VIEW_REVENUE', 'VIEW_REPORTES', 'VIEW_AGENTES_IA', 'EDIT_AGENTES_IA',
    'VIEW_INTEGRACIONES', 'EDIT_INTEGRACIONES', 'ADMIN_FULL_ACCESS'
  );

  RETURN NEW;
END;
$function$

