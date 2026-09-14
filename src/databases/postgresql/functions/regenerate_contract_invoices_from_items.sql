CREATE OR REPLACE FUNCTION public.regenerate_contract_invoices_from_items(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id          uuid;
  v_booking_date        date;
  v_contract_currency   text;
  v_contract_end_date   date;
  v_group_by_period     boolean;
  v_contract_item       record;
  v_period_months       integer;
  v_num_periods         integer;
  v_period_amount       numeric;
  v_invoice_date        date;
  v_invoices_created    integer := 0;
BEGIN
  v_holding_id := get_current_user_holding_id();

  -- Validar acceso al contrato legacy y leer preferencia de agrupación
  SELECT booking_date, contract_currency, contract_end_date,
         COALESCE(group_invoices_by_period, true)
  INTO   v_booking_date, v_contract_currency, v_contract_end_date, v_group_by_period
  FROM   contracts
  WHERE  id = p_contract_id
    AND  holding_id = v_holding_id
    AND  is_legacy = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato legacy no encontrado');
  END IF;

  -- Eliminar SOLO las contract_invoices NO satisfechas.
  -- Las is_satisfied = true (reconciliadas con facturas legacy) se preservan intactas.
  DELETE FROM contract_invoices
  WHERE contract_id = p_contract_id
    AND COALESCE(is_satisfied, false) = false;

  -- Generar per-item usando term_months y billing_frequency propios de cada item.
  -- FIX: saltar invoice_dates que ya tienen una fila is_satisfied=true — evita
  -- crear una "Programada" duplicada encima de una "Satisfecha" existente.
  FOR v_contract_item IN
    SELECT id, product_name, final_price, term_months, billing_frequency, start_date, end_date
    FROM   contract_items
    WHERE  contract_id = p_contract_id
  LOOP
    v_period_months := CASE COALESCE(v_contract_item.billing_frequency, 'Mensual')
      WHEN 'Mensual'    THEN 1
      WHEN 'Trimestral' THEN 3
      WHEN 'Semestral'  THEN 6
      WHEN 'Anual'      THEN 12
      WHEN 'Bianual'    THEN 24
      ELSE 1
    END;

    v_num_periods := CEIL(
      COALESCE(v_contract_item.term_months, 12)::numeric / v_period_months
    );

    v_period_amount := ROUND(
      COALESCE(v_contract_item.final_price, 0) / NULLIF(v_num_periods, 0),
      2
    );

    FOR i IN 0..(v_num_periods - 1) LOOP
      v_invoice_date :=
        COALESCE(v_contract_item.start_date, v_booking_date)
        + (i * v_period_months * INTERVAL '1 month');

      -- Rango del item
      IF v_invoice_date > COALESCE(v_contract_item.end_date, v_contract_end_date, v_invoice_date) THEN
        CONTINUE;
      END IF;

      -- FIX: saltar si ya existe una contract_invoice satisfecha para esta fecha.
      -- Esas facturas ya fueron reconciliadas y no deben duplicarse.
      IF EXISTS (
        SELECT 1 FROM contract_invoices
        WHERE contract_id = p_contract_id
          AND invoice_date = v_invoice_date
          AND COALESCE(is_satisfied, false) = true
      ) THEN
        CONTINUE;
      END IF;

      INSERT INTO contract_invoices (
        contract_id, holding_id, invoice_date, amount, currency,
        status, contract_item_details, is_editable, is_satisfied
      ) VALUES (
        p_contract_id, v_holding_id, v_invoice_date, v_period_amount, v_contract_currency,
        'Programada',
        jsonb_build_array(jsonb_build_object(
          'contract_item_id', v_contract_item.id,
          'product_name',     v_contract_item.product_name,
          'amount',           v_period_amount
        )),
        true, false
      );
      v_invoices_created := v_invoices_created + 1;
    END LOOP;
  END LOOP;

  -- Consolidar por fecha si group_invoices_by_period = true
  IF v_group_by_period THEN
    WITH per_item_data AS (
      SELECT id, invoice_date, amount, contract_item_details
      FROM   contract_invoices
      WHERE  contract_id = p_contract_id
        AND  COALESCE(is_satisfied, false) = false
    ),
    grouped AS (
      SELECT
        invoice_date,
        SUM(amount)  AS total_amount,
        jsonb_agg(detail ORDER BY (detail->>'contract_item_id')::text) AS combined_details
      FROM per_item_data,
      LATERAL jsonb_array_elements(contract_item_details) AS detail
      GROUP BY invoice_date
    ),
    deleted AS (
      DELETE FROM contract_invoices
      WHERE contract_id = p_contract_id
        AND COALESCE(is_satisfied, false) = false
    )
    INSERT INTO contract_invoices (
      contract_id, holding_id, invoice_date, amount, currency,
      status, contract_item_details, is_editable, is_satisfied
    )
    SELECT
      p_contract_id, v_holding_id, invoice_date, total_amount, v_contract_currency,
      'Programada', combined_details, true, false
    FROM grouped;
  END IF;

  RETURN jsonb_build_object(
    'success',          true,
    'invoices_created', v_invoices_created,
    'grouped',          v_group_by_period
  );
END;
$function$

