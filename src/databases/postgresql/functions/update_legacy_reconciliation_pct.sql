CREATE OR REPLACE FUNCTION public.update_legacy_reconciliation_pct(p_contract_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_total_contract_value numeric;
  v_total_satisfied      numeric;
  v_reconciliation_pct   numeric;
BEGIN
  -- Valor total del contrato (suma de final_price de los contract_items)
  SELECT COALESCE(SUM(ci.final_price), 0)
  INTO v_total_contract_value
  FROM contract_items ci
  WHERE ci.contract_id = p_contract_id;

  IF v_total_contract_value = 0 THEN
    UPDATE contracts SET legacy_reconciliation_pct = 0 WHERE id = p_contract_id;
    RETURN;
  END IF;

  -- Monto ya cubierto = suma de contract_invoices con is_satisfied = true.
  -- Estas son las facturas programadas que ya fueron reconciliadas con una
  -- factura legacy a través de reconcile_legacy_invoice().
  SELECT COALESCE(SUM(ci.amount), 0)
  INTO v_total_satisfied
  FROM contract_invoices ci
  WHERE ci.contract_id = p_contract_id
    AND COALESCE(ci.is_satisfied, false) = true;

  v_reconciliation_pct := LEAST((v_total_satisfied / v_total_contract_value) * 100, 100);

  UPDATE contracts
  SET legacy_reconciliation_pct = ROUND(v_reconciliation_pct, 2)
  WHERE id = p_contract_id;

  RAISE NOTICE '[LEGACY_PCT] Contract %: % satisfied / % total = % pct',
    p_contract_id, v_total_satisfied, v_total_contract_value, ROUND(v_reconciliation_pct, 2);
END;
$function$;

COMMENT ON FUNCTION public."update_legacy_reconciliation_pct"(p_contract_id uuid) IS 'Calcula y actualiza legacy_reconciliation_pct del contrato.
   FIX 20260302170000: ahora lee de contract_invoices.is_satisfied=true (flujo nuevo)
   en vez de invoice_items_legacy_match (flujo antiguo, siempre vacío).';
