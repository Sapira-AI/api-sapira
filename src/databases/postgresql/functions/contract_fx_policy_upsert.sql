CREATE OR REPLACE FUNCTION public.contract_fx_policy_upsert(p_contract_id uuid, p_company_fx_policy fx_policy_type DEFAULT 'holding_default'::fx_policy_type, p_company_fx_fixed_rate numeric DEFAULT NULL::numeric, p_company_fx_table_id uuid DEFAULT NULL::uuid, p_system_fx_policy fx_policy_type DEFAULT 'holding_default'::fx_policy_type, p_system_fx_fixed_rate numeric DEFAULT NULL::numeric, p_system_fx_table_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id UUID;
  v_policy_id UUID;
  v_user_id UUID;
BEGIN
  -- Obtener holding del contrato
  SELECT holding_id INTO v_holding_id
  FROM public.contracts
  WHERE id = p_contract_id
    AND holding_id = get_current_user_holding_id();
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Contract not found or no access';
  END IF;

  -- Obtener user_id
  SELECT id INTO v_user_id
  FROM public.users
  WHERE auth_id = auth.uid();

  -- Upsert política
  INSERT INTO public.contract_fx_policies (
    contract_id,
    holding_id,
    company_fx_policy,
    company_fx_fixed_rate,
    company_fx_table_id,
    system_fx_policy,
    system_fx_fixed_rate,
    system_fx_table_id,
    created_by
  ) VALUES (
    p_contract_id,
    v_holding_id,
    p_company_fx_policy,
    p_company_fx_fixed_rate,
    p_company_fx_table_id,
    p_system_fx_policy,
    p_system_fx_fixed_rate,
    p_system_fx_table_id,
    v_user_id
  )
  ON CONFLICT (contract_id) DO UPDATE SET
    company_fx_policy = EXCLUDED.company_fx_policy,
    company_fx_fixed_rate = EXCLUDED.company_fx_fixed_rate,
    company_fx_table_id = EXCLUDED.company_fx_table_id,
    system_fx_policy = EXCLUDED.system_fx_policy,
    system_fx_fixed_rate = EXCLUDED.system_fx_fixed_rate,
    system_fx_table_id = EXCLUDED.system_fx_table_id,
    updated_at = now()
  RETURNING id INTO v_policy_id;

  RETURN v_policy_id;
END;
$function$

