CREATE OR REPLACE FUNCTION public.nc_discount_revenue_adjustment(p_contract_id uuid, p_contract_item_id uuid, p_month date, p_item_start_month date, p_item_active_end_month date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH adj AS (
    -- Fuente 1 (sin cambios): NC de descuento Emitidas y clasificadas. El
    -- subtotal de la línea de la NC ya es negativo.
    SELECT nc.nc_revenue_treatment AS treatment,
           nc.issue_date AS ref_date,
           nii.subtotal_contract_currency AS amount,
           nii.billing_period_start AS period_start,
           nii.billing_period_end AS period_end
    FROM public.invoices nc
    JOIN public.invoice_items nii ON nii.invoice_id = nc.id
    WHERE nc.contract_id = p_contract_id
      AND nii.contract_item_id = p_contract_item_id
      AND nc.document_type = 'NC'
      AND nc.credit_type = 'discount'
      -- Una NC no vence: nace de una factura y se cierra con ella (Domi 30-09). La tarea programada del front viejo
      -- (`check-overdue-invoices`) igual la deja en 'Vencida', así que cuenta cualquier estado de NC emitida.
      AND nc.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')
      AND nc.is_active = true
      AND nc.nc_revenue_treatment IS NOT NULL

    UNION ALL

    -- Fuente 2 (facturas en el 360, etapa 4): descuento puntual de una factura
    -- (no NC) de la línea, guardado como sublínea del pricing_breakdown
    -- { kind: 'discount', one_off: true, amount: -X }. Cuenta desde que se
    -- registra (también Por Emitir); cancelar la factura lo quita. Si la factura
    -- ya tiene una NC de descuento clasificada vigente, manda la NC (sin doble
    -- conteo).
    SELECT i.nc_revenue_treatment,
           i.issue_date,
           o.amount,
           ii.billing_period_start,
           ii.billing_period_end
    FROM public.invoices i
    JOIN public.invoice_items ii ON ii.invoice_id = i.id
    CROSS JOIN LATERAL (
      SELECT SUM((elem->>'amount')::numeric) AS amount
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(ii.pricing_breakdown) = 'array' THEN ii.pricing_breakdown ELSE '[]'::jsonb END
      ) elem
      WHERE elem->>'kind' = 'discount'
        AND COALESCE((elem->>'one_off')::boolean, false)
    ) o
    WHERE i.contract_id = p_contract_id
      AND ii.contract_item_id = p_contract_item_id
      AND i.nc_revenue_treatment IS NOT NULL
      AND i.is_active = true
      AND COALESCE(i.document_type, '') <> 'NC'
      AND i.status IS DISTINCT FROM 'Cancelada'
      AND o.amount IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.invoices dnc
        WHERE dnc.related_invoice_id = i.id
          AND dnc.document_type = 'NC'
          AND dnc.credit_type = 'discount'
          AND dnc.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')
          AND dnc.is_active = true
          AND dnc.nc_revenue_treatment IS NOT NULL
      )
  )
  SELECT COALESCE(SUM(
    CASE
      -- service_period: partes iguales en los meses calendario del período de
      -- servicio de la línea (redondeo telescópico: suma exacta). Sin período
      -- válido degenera a impact_month (rama siguiente).
      WHEN a.treatment = 'service_period' AND s.n_months IS NOT NULL
      THEN CASE WHEN p_month >= s.sp_start AND p_month <= s.sp_end
                THEN ROUND(a.amount * s.k / s.n_months, 2)
                   - ROUND(a.amount * (s.k - 1) / s.n_months, 2)
                ELSE 0 END
      -- impact_month, o defer degenerado (la referencia cae después del fin
      -- activo del ítem): todo el monto al mes de la referencia (fecha de la NC
      -- o de emisión de la factura).
      WHEN a.treatment IN ('impact_month', 'service_period')
           OR m.n_months IS NULL
      THEN CASE WHEN d.ref_month = p_month THEN a.amount ELSE 0 END
      -- defer_forward: cuota k de n con redondeo telescópico (suma exacta).
      WHEN a.treatment = 'defer_forward'
           AND p_month >= d.defer_start
           AND p_month <= p_item_active_end_month
      THEN ROUND(a.amount * m.k / m.n_months, 2)
         - ROUND(a.amount * (m.k - 1) / m.n_months, 2)
      ELSE 0
    END
  ), 0)
  FROM adj a
  CROSS JOIN LATERAL (
    SELECT DATE_TRUNC('month', a.ref_date)::date AS ref_month,
           GREATEST(DATE_TRUNC('month', a.ref_date)::date, p_item_start_month) AS defer_start
  ) d
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN p_item_active_end_month IS NULL OR d.defer_start > p_item_active_end_month THEN NULL
           ELSE ((EXTRACT(YEAR FROM p_item_active_end_month) - EXTRACT(YEAR FROM d.defer_start)) * 12
                + EXTRACT(MONTH FROM p_item_active_end_month) - EXTRACT(MONTH FROM d.defer_start) + 1)::int
      END AS n_months,
      ((EXTRACT(YEAR FROM p_month) - EXTRACT(YEAR FROM d.defer_start)) * 12
       + EXTRACT(MONTH FROM p_month) - EXTRACT(MONTH FROM d.defer_start) + 1)::int AS k
  ) m
  CROSS JOIN LATERAL (
    SELECT DATE_TRUNC('month', a.period_start)::date AS sp_start,
           DATE_TRUNC('month', a.period_end)::date AS sp_end,
      CASE WHEN a.period_start IS NULL OR a.period_end IS NULL OR a.period_end < a.period_start THEN NULL
           ELSE ((EXTRACT(YEAR FROM a.period_end) - EXTRACT(YEAR FROM a.period_start)) * 12
                + EXTRACT(MONTH FROM a.period_end) - EXTRACT(MONTH FROM a.period_start) + 1)::int
      END AS n_months,
      ((EXTRACT(YEAR FROM p_month) - EXTRACT(YEAR FROM a.period_start)) * 12
       + EXTRACT(MONTH FROM p_month) - EXTRACT(MONTH FROM a.period_start) + 1)::int AS k
  ) s
$function$;

COMMENT ON FUNCTION public."nc_discount_revenue_adjustment"(p_contract_id uuid, p_contract_item_id uuid, p_month date, p_item_start_month date, p_item_active_end_month date) IS 'Ajuste (negativo) de recognized por ítem y mes. Fuentes: (1) NC discount emitida (Emitida/Enviada/Vencida/Pagada: una NC no vence) con nc_revenue_treatment NOT NULL; (2) descuento puntual de una factura no NC (sublíneas {kind: discount, one_off: true} del pricing_breakdown) con nc_revenue_treatment NOT NULL, activa y no Cancelada, salvo que tenga una NC discount clasificada vigente (manda la NC). Tratamientos: impact_month (mes de la NC / emisión), defer_forward (desde ese mes hasta el fin activo del ítem), service_period (meses del período de servicio de la línea; sin período = impact_month).';
