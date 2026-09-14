CREATE OR REPLACE FUNCTION public.bootstrap_accounting_period_cutoffs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo super_admin puede ejecutar bootstrap_accounting_period_cutoffs'
      USING ERRCODE = '42501';
  END IF;

  WITH active_pairs AS (
    SELECT co.holding_id, co.id AS company_id
      FROM public.companies co
     WHERE co.holding_id IS NOT NULL
       AND ( EXISTS (SELECT 1 FROM public.contracts c WHERE c.company_id = co.id)
          OR EXISTS (SELECT 1 FROM public.invoices  i WHERE i.company_id = co.id) )
  ),
  inserted AS (
    INSERT INTO public.accounting_period_cutoff (holding_id, company_id, cutoff_date)
    SELECT ap.holding_id, ap.company_id, NULL
      FROM active_pairs ap
     WHERE NOT EXISTS (
       SELECT 1 FROM public.accounting_period_cutoff apc
        WHERE apc.holding_id = ap.holding_id
          AND apc.company_id = ap.company_id
     )
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;

  RETURN v_inserted;
END $function$

