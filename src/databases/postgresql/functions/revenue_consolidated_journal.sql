CREATE OR REPLACE FUNCTION public.revenue_consolidated_journal(p_from date, p_to date, p_granularity text DEFAULT 'month'::text, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(holding_id uuid, company_id uuid, period_start date, account_code text, account_name text, debit numeric, credit numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_gran text;
begin
  v_gran := case lower(coalesce(p_granularity,'month'))
              when 'day' then 'day'
              when 'week' then 'week'
              else 'month'
            end;

  return query
  with periods as (
    select generate_series(
      date_trunc(v_gran, p_from::timestamptz),
      date_trunc(v_gran, p_to::timestamptz),
      case when v_gran='day' then interval '1 day'
           when v_gran='week' then interval '1 week'
           else interval '1 month' end
    )::date as period
  ),
  -- Reconocido (prorrateo diario por ítem)
  items as (
    select
      ci.id as item_id,
      c.company_id,                  -- CORREGIDO: tomar company_id desde contracts
      c.holding_id,
      ci.currency,
      ci.final_price,
      (ci.start_date)::date as start_date,
      (ci.start_date + (ci.term_months||' months')::interval)::date as end_date
    from public.contract_items ci
    join public.contracts c on c.id = ci.contract_id
    where c.status = 'Activo'
      and ci.final_price is not null
      and ci.final_price > 0
      and ci.term_months is not null
      and ci.term_months > 0
      and ci.start_date is not null
      and (p_company_id is null or c.company_id = p_company_id)
  ),
  item_days as (
    select
      i.company_id,
      i.holding_id,
      i.currency,
      i.final_price,
      d::date as day,
      greatest((i.end_date - i.start_date), 1) as total_days
    from items i,
    lateral generate_series(
      greatest(i.start_date, p_from),
      least(i.end_date - interval '1 day', p_to),
      interval '1 day'
    ) as d
    where i.end_date > i.start_date
  ),
  r as (
    select
      idy.company_id,
      idy.holding_id,
      date_trunc(v_gran, idy.day)::date as period,
      sum( (idy.final_price / nullif(idy.total_days,0)) * public.fx_rate(idy.day, idy.currency) ) as recognized_sys
    from item_days idy
    group by 1,2,3
  ),
  -- Facturado emitido del período (sin IVA): i.status = 'Enviada'
  b as (
    select
      i.company_id,
      i.holding_id,
      date_trunc(v_gran, i.issue_date)::date as period,
      sum( coalesce(i.amount_net, 0) * public.fx_rate(i.issue_date, coalesce(i.invoice_currency, i.contract_currency)) ) as billed_sys
    from public.invoices i
    where i.issue_date between p_from and p_to
      and i.status = 'Enviada'
      and (p_company_id is null or i.company_id = p_company_id)
    group by 1,2,3
  ),
  agg as (
    select
      coalesce(r.holding_id, b.holding_id) as holding_id,
      coalesce(r.company_id, b.company_id) as company_id,
      coalesce(r.period, b.period) as period,
      coalesce(r.recognized_sys,0) as recognized,
      coalesce(b.billed_sys,0) as billed
    from r full join b
      on r.company_id = b.company_id and r.period = b.period
  ),
  lines as (
    select
      a.holding_id,
      a.company_id,
      a.period,
      case when a.recognized >= a.billed
           then jsonb_build_array(
                  jsonb_build_object('account','Contract Asset (Unbilled)','code','1.1.03','debit', a.recognized - a.billed, 'credit',0),
                  jsonb_build_object('account','Revenue','code','4.1.01','debit', 0,'credit', a.recognized - a.billed)
                )
           else jsonb_build_array(
                  jsonb_build_object('account','Revenue','code','4.1.01','debit', a.billed - a.recognized, 'credit',0),
                  jsonb_build_object('account','Deferred Revenue','code','2.2.05','debit', 0,'credit', a.billed - a.recognized)
                )
      end as entries
    from agg a
    where (a.recognized <> 0 or a.billed <> 0)
  )
  select
    l.holding_id,
    l.company_id,
    l.period as period_start,
    (e->>'code')::text as account_code,
    (e->>'account')::text as account_name,
    ((e->>'debit')::numeric) as debit,
    ((e->>'credit')::numeric) as credit
  from lines l
  cross join lateral jsonb_array_elements(l.entries) as e
  where ((e->>'debit')::numeric <> 0 or (e->>'credit')::numeric <> 0)
  order by l.period, l.company_id, account_code;
end
$function$

