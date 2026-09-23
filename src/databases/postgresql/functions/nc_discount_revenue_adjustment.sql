CREATE OR REPLACE FUNCTION public.nc_discount_revenue_adjustment(p_contract_id uuid, p_contract_item_id uuid, p_month date, p_item_start_month date, p_item_active_end_month date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(
    CASE
      -- impact_month, o defer degenerado (la NC cae después del fin activo del
      -- ítem): todo el monto al mes de la NC.
      WHEN nc.nc_revenue_treatment = 'impact_month'
           OR m.n_months IS NULL
      THEN CASE WHEN d.nc_month = p_month THEN nii.subtotal_contract_currency ELSE 0 END
      -- defer_forward: cuota k de n con redondeo telescópico (suma exacta).
      WHEN nc.nc_revenue_treatment = 'defer_forward'
           AND p_month >= d.defer_start
           AND p_month <= p_item_active_end_month
      THEN ROUND(nii.subtotal_contract_currency * m.k / m.n_months, 2)
         - ROUND(nii.subtotal_contract_currency * (m.k - 1) / m.n_months, 2)
      ELSE 0
    END
  ), 0)
  FROM public.invoices nc
  JOIN public.invoice_items nii ON nii.invoice_id = nc.id
  CROSS JOIN LATERAL (
    SELECT DATE_TRUNC('month', nc.issue_date)::date AS nc_month,
           GREATEST(DATE_TRUNC('month', nc.issue_date)::date, p_item_start_month) AS defer_start
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
  WHERE nc.contract_id = p_contract_id
    AND nii.contract_item_id = p_contract_item_id
    AND nc.document_type = 'NC'
    AND nc.credit_type = 'discount'
    AND nc.status = 'Emitida'
    AND nc.is_active = true
    AND nc.nc_revenue_treatment IS NOT NULL
$function$;

COMMENT ON FUNCTION public."nc_discount_revenue_adjustment"(p_contract_id uuid, p_contract_item_id uuid, p_month date, p_item_start_month date, p_item_active_end_month date) IS 'Ajuste (negativo) de recognized por NC de descuento clasificadas, por ítem y mes. Solo NC discount Emitida con nc_revenue_treatment NOT NULL.';
