-- Cotizaciones v2 (mapa §7): el seed de etapas para un holding nuevo pasa del set viejo (Borrador, Enviada, En Revisión, Aprobada,
-- Rechazada, Cerrada - Ganada, Cerrada - Perdida; nombres que ningún front usaba) al set v2 con `kind` (Q-A1). Solo afecta holdings
-- nuevos: los existentes se backfillean en la migración 1790650000000-QuotesV2. Mismo set que `DEFAULT_QUOTE_STAGES`
-- en `src/modules/quotes/quote-status.ts`.
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
      -- Insert default quote stages (v2: with system kind)
      INSERT INTO public.quote_stages (holding_id, name, color, position, is_system_stage, is_deletable, kind,
  created_at, updated_at)
      VALUES
        (p_holding_id, 'Borrador', '#94a3b8', 1, true, false, 'draft', NOW(), NOW()),
        (p_holding_id, 'Enviada', '#3b82f6', 2, true, false, 'sent', NOW(), NOW()),
        (p_holding_id, 'Firmada', '#10b981', 3, true, false, 'signed', NOW(), NOW()),
        (p_holding_id, 'Perdida', '#ef4444', 4, true, false, 'lost', NOW(), NOW()),
        (p_holding_id, 'Contrato creado', '#6366f1', 5, true, false, 'contract_created', NOW(), NOW());
    END IF;
  END;
  $function$
