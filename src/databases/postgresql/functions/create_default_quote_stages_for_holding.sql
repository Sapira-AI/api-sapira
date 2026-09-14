CREATE OR REPLACE FUNCTION public.create_default_quote_stages_for_holding(p_holding_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  BEGIN
    -- Check if the holding already has quote stages
    IF NOT EXISTS (
      SELECT 1 FROM public.quote_stages
      WHERE holding_id = p_holding_id
    ) THEN
      -- Insert default quote stages
      INSERT INTO public.quote_stages (holding_id, name, color, position,
  created_at, updated_at)
      VALUES
        (p_holding_id, 'Borrador', '#94a3b8', 1, NOW(), NOW()),
        (p_holding_id, 'Enviada', '#3b82f6', 2, NOW(), NOW()),
        (p_holding_id, 'En Revisión', '#f59e0b', 3, NOW(), NOW()),
        (p_holding_id, 'Aprobada', '#10b981', 4, NOW(), NOW()),
        (p_holding_id, 'Rechazada', '#ef4444', 5, NOW(), NOW()),
        (p_holding_id, 'Cerrada - Ganada', '#22c55e', 6, NOW(), NOW()),
        (p_holding_id, 'Cerrada - Perdida', '#991b1b', 7, NOW(), NOW());
    END IF;
  END;
  $function$

