CREATE OR REPLACE FUNCTION public.bulk_restructure_contract_start_dates(p_contract_ids uuid[], p_cutoff_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_holding_id uuid;
  v_contract_id       uuid;
  v_processed         jsonb := '[]'::jsonb;
  v_skipped           jsonb := '[]'::jsonb;
  v_errors            jsonb := '[]'::jsonb;
  v_new_min_start     date;
  v_items_updated     int;
  v_inv_deleted       int;
  v_status            text;
  v_contract_holding  uuid;
  v_has_erp_invoice   boolean;
  v_regen_result      jsonb;
  v_gen_count         int;
  v_gen_record        record;
BEGIN
  IF p_contract_ids IS NULL OR array_length(p_contract_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('processed', '[]'::jsonb, 'skipped', '[]'::jsonb, 'errors', '[]'::jsonb);
  END IF;
  IF p_cutoff_date IS NULL THEN
    RAISE EXCEPTION 'p_cutoff_date no puede ser NULL';
  END IF;

  v_caller_holding_id := get_current_user_holding_id();
  IF v_caller_holding_id IS NULL THEN
    RAISE EXCEPTION 'Caller sin holding válido';
  END IF;

  FOREACH v_contract_id IN ARRAY p_contract_ids LOOP
    BEGIN
      SELECT status, holding_id
        INTO v_status, v_contract_holding
        FROM contracts
       WHERE id = v_contract_id;

      IF NOT FOUND THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'contract_id', v_contract_id, 'reason', 'not_found'));
        CONTINUE;
      END IF;

      IF v_contract_holding IS DISTINCT FROM v_caller_holding_id THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'contract_id', v_contract_id, 'reason', 'forbidden_holding'));
        CONTINUE;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM invoices
         WHERE contract_id = v_contract_id
           AND odoo_invoice_id IS NOT NULL
           AND COALESCE(is_legacy, false) = false
           AND is_active = true
      ) INTO v_has_erp_invoice;

      IF v_has_erp_invoice THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'contract_id', v_contract_id, 'reason', 'has_erp_invoice'));
        CONTINUE;
      END IF;

      WITH shifted AS (
        UPDATE contract_items
           SET start_date  = compute_new_contract_start(start_date, p_cutoff_date),
               term_months = GREATEST(1, months_between_dates(
                               (end_date + INTERVAL '1 day')::date,
                               compute_new_contract_start(start_date, p_cutoff_date)
                             ))
         WHERE contract_id = v_contract_id
           AND start_date IS NOT NULL
           AND term_months IS NOT NULL
           AND end_date IS NOT NULL
           AND start_date <= p_cutoff_date
           AND end_date > p_cutoff_date
        RETURNING start_date
      )
      SELECT MIN(start_date), COUNT(*) INTO v_new_min_start, v_items_updated FROM shifted;

      IF COALESCE(v_items_updated, 0) = 0 THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'contract_id', v_contract_id, 'reason', 'no_items_to_shift'));
        CONTINUE;
      END IF;

      UPDATE contracts
         SET booking_date       = v_new_min_start,
             legacy_cutoff_date = p_cutoff_date
       WHERE id = v_contract_id;

      DELETE FROM invoice_items
       WHERE invoice_id IN (
         SELECT id FROM invoices
          WHERE contract_id = v_contract_id
            AND status = 'Por Emitir'
       );
      WITH del AS (
        DELETE FROM invoices
         WHERE contract_id = v_contract_id
           AND status = 'Por Emitir'
        RETURNING id
      )
      SELECT COUNT(*) INTO v_inv_deleted FROM del;

      v_regen_result := regenerate_contract_invoices_for_restructure(v_contract_id);
      IF NOT COALESCE((v_regen_result->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'regenerate_contract_invoices_for_restructure failed: %',
          COALESCE(v_regen_result->>'error', 'unknown');
      END IF;

      v_gen_count := 0;
      IF v_status = 'Activo' THEN
        FOR v_gen_record IN
          SELECT * FROM generate_missing_invoices_for_contract(v_contract_id)
        LOOP
          v_gen_count := COALESCE(v_gen_record.generated_count, 0);
        END LOOP;
      END IF;

      v_processed := v_processed || jsonb_build_array(jsonb_build_object(
        'contract_id',             v_contract_id,
        'status',                  v_status,
        'new_start_date',          v_new_min_start,
        'items_updated',           v_items_updated,
        'invoices_deleted',        v_inv_deleted,
        'contract_invoices_regen', COALESCE((v_regen_result->>'invoices_created')::int, 0),
        'invoices_regen',          v_gen_count
      ));

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'contract_id', v_contract_id,
        'error',       SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'skipped',   v_skipped,
    'errors',    v_errors
  );
END;
$function$

