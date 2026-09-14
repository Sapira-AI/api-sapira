CREATE OR REPLACE FUNCTION public.revenue_consolidated_summary(p_from date, p_to date, p_granularity text DEFAULT 'month'::text, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(holding_id uuid, company_id uuid, period_start date, recognized numeric, billed numeric, unbilled numeric, deferred numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with j as (
    select holding_id, company_id, period_start, account_code, account_name, debit, credit
    from public.revenue_consolidated_journal(p_from, p_to, p_granularity, p_company_id)
  ),
  agg as (
    select
      holding_id,
      company_id,
      period_start,
      sum(case when account_name='Revenue' then credit - debit else 0 end) as recognized,
      sum(case when account_name='Contract Asset (Unbilled)' then debit - credit else 0 end) as unbilled,
      sum(case when account_name='Deferred Revenue' then credit - debit else 0 end) as deferred
    from j
    group by 1,2,3
  )
  select
    a.holding_id,
    a.company_id,
    a.period_start,
    coalesce(a.recognized,0) as recognized,
    coalesce(a.recognized,0) + (coalesce(a.deferred,0) - coalesce(a.unbilled,0)) as billed,
    coalesce(a.unbilled,0) as unbilled,
    coalesce(a.deferred,0) as deferred
  from agg a
  order by a.period_start, a.company_id;
$function$

