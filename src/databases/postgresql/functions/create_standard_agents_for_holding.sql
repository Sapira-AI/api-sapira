CREATE OR REPLACE FUNCTION public.create_standard_agents_for_holding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_proforma_agent_id UUID;
  v_collections_agent_id UUID;
  v_system_user_id UUID := '00000000-0000-0000-0000-000000000001'; -- Usuario del sistema
BEGIN
  -- Crear agente de Proformas
  INSERT INTO ai_agents (
    holding_id, 
    type, 
    name, 
    is_enabled, 
    schedule, 
    created_by,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    'proforma',
    'Solicitud de Referencias',
    true,
    '0 9 * * 1-5', -- 9 AM de lunes a viernes
    v_system_user_id,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_proforma_agent_id;
  
  -- Configuración por defecto para Proformas
  INSERT INTO ai_agent_configs (agent_id, key, value_json)
  VALUES
    (v_proforma_agent_id, 'days_before_issue', '10'),
    (v_proforma_agent_id, 'require_approval', 'true'),
    (v_proforma_agent_id, 'allowed_reference_types', '["OC","HES","Aceptación"]'),
    (v_proforma_agent_id, 'email_subject_template', '"Solicitud de referencia - {{client_name}}"'),
    (v_proforma_agent_id, 'email_body_template', '"<p>Estimado/a {{contact_name}},</p><p>Le enviamos la proforma de {{client_name}} correspondiente a la factura programada para el {{formatted_date}}.</p><p>Por favor, envíenos la orden de compra o referencia correspondiente para proceder con la emisión.</p><p>Saludos cordiales</p>"');
  
  -- Crear agente de Cobranzas
  INSERT INTO ai_agents (
    holding_id, 
    type, 
    name, 
    is_enabled, 
    schedule, 
    created_by,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    'collections',
    'Recordatorios de Cobranza',
    true,
    '0 0 * * *', -- Diario a medianoche
    v_system_user_id,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_collections_agent_id;
  
  -- Configuración por defecto para Cobranzas
  INSERT INTO ai_agent_configs (agent_id, key, value_json)
  VALUES
    (v_collections_agent_id, 'days_overdue_bucket_1', '30'),
    (v_collections_agent_id, 'frequency_bucket_1', '168'), -- Cada semana (168 horas)
    (v_collections_agent_id, 'template_bucket_1', '"recordatorio_30_dias"'),
    (v_collections_agent_id, 'email_subject_bucket_1', '"Recordatorio de pago - {{client_name}}"'),
    (v_collections_agent_id, 'email_body_bucket_1', '"<p>Estimado/a {{contact_name}},</p><p>Le recordamos que {{client_name}} tiene {{invoice_count}} factura(s) pendiente(s) de pago por un total de {{total_amount}}.</p>{{invoices_table}}<p>Agradecemos su pronta atención a este asunto.</p><p>Saludos cordiales</p>"'),
    (v_collections_agent_id, 'days_overdue_bucket_2', '60'),
    (v_collections_agent_id, 'frequency_bucket_2', '24'), -- Diario (24 horas)
    (v_collections_agent_id, 'template_bucket_2', '"recordatorio_60_dias"'),
    (v_collections_agent_id, 'email_subject_bucket_2', '"AVISO IMPORTANTE: Pago pendiente - {{client_name}}"'),
    (v_collections_agent_id, 'email_body_bucket_2', '"<p>Estimado/a {{contact_name}},</p><p><strong>AVISO IMPORTANTE:</strong> {{client_name}} tiene {{invoice_count}} factura(s) con vencimiento considerable por un total de {{total_amount}}.</p>{{invoices_table}}<p>Le solicitamos regularizar esta situación a la brevedad posible.</p><p>Atentamente</p>"'),
    (v_collections_agent_id, 'require_approval', 'true');
  
  RAISE NOTICE 'Agentes estándar creados para holding %: Proforma (%), Collections (%)', 
    NEW.id, v_proforma_agent_id, v_collections_agent_id;
  
  RETURN NEW;
END;
$function$

