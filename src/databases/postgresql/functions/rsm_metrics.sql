CREATE OR REPLACE FUNCTION public.rsm_metrics(date_from date, date_to date, metric text, currency_mode text DEFAULT 'system'::text, group_by text[] DEFAULT ARRAY['period_month'::text], filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(period_month date, company_id uuid, client_id uuid, segment text, market text, industry text, momentum text, product_name text, value numeric, currency text)
 LANGUAGE plpgsql
AS $function$
declare
  holding uuid;
  metric_col text;
  use_total_row boolean;
begin
  select public.get_current_user_holding_id() into holding;
  if holding is null then
    raise exception 'No holding_id for current user';
  end if;

  if date_from is null or date_to is null then
    raise exception 'date_from and date_to are required';
  end if;

  currency_mode := lower(coalesce(currency_mode,'system'));
  if currency_mode not in ('system','company','contract') then
    raise exception 'Invalid currency_mode: %', currency_mode;
  end if;

  case lower(metric)
    when 'mrr' then metric_col := 'mrr_period';
    when 'mrr_contracted' then metric_col := 'mrr_period_contracted';
    when 'cmrr' then metric_col := 'cmrr_period';
    when 'recognized' then metric_col := 'recognized_period';
    when 'billed' then metric_col := 'billed_period';
    when 'deferred_eom' then metric_col := 'deferred_balance_eom';
    when 'deferred_period' then metric_col := 'deferred_balance_period';
    when 'unbilled_eom' then metric_col := 'unbilled_balance_eom';
    when 'unbilled_period' then metric_col := 'unbilled_balance_period';
    else
      raise exception 'Invalid metric: %', metric;
  end case;

  if currency_mode = 'system' then
    metric_col := metric_col || '_system_ccy';
  elsif currency_mode = 'company' then
    metric_col := metric_col || '_ccy';
  else
    metric_col := metric_col || '_contract_ccy';
  end if;

  use_total_row := coalesce((filters->>'is_total_row')::boolean, true);

  return query
  with base as (
    select
      r.period_month as period_month,
      r.company_id as company_id,
      -- ✅ FIX: client_id desde contrato O suscripción
      COALESCE(c.client_id, s.client_id) as client_id,
      cl.segment as segment,
      cl.market as market,
      cl.industry as industry,
      r.momentum as momentum,
      r.product_name as product_name,
      case metric_col
        when 'mrr_period_system_ccy' then r.mrr_period_system_ccy
        when 'mrr_period_ccy' then r.mrr_period_ccy
        when 'mrr_period_contract_ccy' then r.mrr_period_contract_ccy

        when 'mrr_period_contracted_system_ccy' then r.mrr_period_contracted_system_ccy
        when 'mrr_period_contracted_ccy' then r.mrr_period_contracted_ccy
        when 'mrr_period_contracted_contract_ccy' then r.mrr_period_contracted_contract_ccy

        when 'cmrr_period_system_ccy' then r.cmrr_period_system_ccy
        when 'cmrr_period_ccy' then r.cmrr_period_ccy
        when 'cmrr_period_contract_ccy' then r.cmrr_period_contract_ccy

        when 'recognized_period_system_ccy' then r.recognized_period_system_ccy
        when 'recognized_period_ccy' then r.recognized_period_ccy
        when 'recognized_period_contract_ccy' then r.recognized_period_contract_ccy

        when 'billed_period_system_ccy' then r.billed_period_system_ccy
        when 'billed_period_ccy' then r.billed_period_ccy
        when 'billed_period_contract_ccy' then r.billed_period_contract_ccy

        when 'deferred_balance_eom_system_ccy' then r.deferred_balance_eom_system_ccy
        when 'deferred_balance_eom_ccy' then r.deferred_balance_eom_ccy
        when 'deferred_balance_eom_contract_ccy' then r.deferred_balance_eom_contract_ccy

        when 'deferred_balance_period_system_ccy' then r.deferred_balance_period_system_ccy
        when 'deferred_balance_period_ccy' then r.deferred_balance_period_ccy
        when 'deferred_balance_period_contract_ccy' then r.deferred_balance_period_contract_ccy

        when 'unbilled_balance_eom_system_ccy' then r.unbilled_balance_eom_system_ccy
        when 'unbilled_balance_eom_ccy' then r.unbilled_balance_eom_ccy
        when 'unbilled_balance_eom_contract_ccy' then r.unbilled_balance_eom_contract_ccy

        when 'unbilled_balance_period_system_ccy' then r.unbilled_balance_period_system_ccy
        when 'unbilled_balance_period_ccy' then r.unbilled_balance_period_ccy
        when 'unbilled_balance_period_contract_ccy' then r.unbilled_balance_period_contract_ccy
        else 0
      end as metric_value,
      r.system_currency as system_currency,
      r.company_currency as company_currency,
      r.contract_currency as contract_currency
    from public.revenue_schedule_monthly r
    -- ✅ FIX: LEFT JOIN para incluir RSM sin contract_id (suscripciones)
    left join public.contracts c on c.id = r.contract_id
    -- ✅ NEW: JOIN a subscriptions para RSM de suscripciones
    left join public.subscriptions s on s.id = r.subscription_id
    -- ✅ FIX: client desde contrato O suscripción
    left join public.clients cl on cl.id = COALESCE(c.client_id, s.client_id)
    where
      -- ✅ FIX: usar r.holding_id directamente (funciona para ambos)
      r.holding_id = holding
      and r.period_month >= date_trunc('month', date_from)::date
      and r.period_month <= date_trunc('month', date_to)::date
      and (not use_total_row or r.is_total_row = true)

      and (filters->>'company_id' is null or r.company_id = (filters->>'company_id')::uuid)
      and (filters->>'contract_id' is null or r.contract_id = (filters->>'contract_id')::uuid)
      -- ✅ NEW: filtro por subscription_id
      and (filters->>'subscription_id' is null or r.subscription_id = (filters->>'subscription_id')::uuid)
      -- ✅ FIX: client_id desde contrato O suscripción
      and (filters->>'client_id' is null or COALESCE(c.client_id, s.client_id) = (filters->>'client_id')::uuid)
      and (filters->>'segment' is null or cl.segment = (filters->>'segment'))
      and (filters->>'market' is null or cl.market = (filters->>'market'))
      and (filters->>'industry' is null or cl.industry = (filters->>'industry'))
      and (filters->>'momentum' is null or r.momentum = (filters->>'momentum'))
      and (filters->>'product_name' is null or r.product_name = (filters->>'product_name'))
  )
  select
    (case when 'period_month' = any(group_by) then b.period_month else null end) as period_month,
    (case when 'company_id' = any(group_by) then b.company_id else null end) as company_id,
    (case when 'client_id' = any(group_by) then b.client_id else null end) as client_id,
    (case when 'segment' = any(group_by) then b.segment else null end) as segment,
    (case when 'market' = any(group_by) then b.market else null end) as market,
    (case when 'industry' = any(group_by) then b.industry else null end) as industry,
    (case when 'momentum' = any(group_by) then b.momentum else null end) as momentum,
    (case when 'product_name' = any(group_by) then b.product_name else null end) as product_name,
    coalesce(sum(b.metric_value),0) as value,
    case
      when currency_mode='system' then max(b.system_currency)
      when currency_mode='company' then max(b.company_currency)
      else max(b.contract_currency)
    end as currency
  from base b
  group by
    (case when 'period_month' = any(group_by) then b.period_month else null end),
    (case when 'company_id' = any(group_by) then b.company_id else null end),
    (case when 'client_id' = any(group_by) then b.client_id else null end),
    (case when 'segment' = any(group_by) then b.segment else null end),
    (case when 'market' = any(group_by) then b.market else null end),
    (case when 'industry' = any(group_by) then b.industry else null end),
    (case when 'momentum' = any(group_by) then b.momentum else null end),
    (case when 'product_name' = any(group_by) then b.product_name else null end)
  order by
    (case when 'period_month' = any(group_by) then b.period_month else null end) asc,
    value desc;

end;
$function$


CREATE OR REPLACE FUNCTION public.rsm_metrics(params jsonb)
 RETURNS TABLE(period_month date, company_id uuid, client_id uuid, segment text, market text, industry text, momentum text, product_name text, value numeric, currency text)
 LANGUAGE plpgsql
AS $function$
declare
  holding uuid;
  v_date_from date;
  v_date_to date;
  v_metric text;
  v_currency_mode text;
  v_group_by text[];
  v_filters jsonb;
  last_month date;
begin
  select public.get_current_user_holding_id() into holding;
  if holding is null then
    raise exception 'No holding_id for current user';
  end if;

  select max(r.period_month) into last_month
  from public.revenue_schedule_monthly r
  where r.holding_id = holding;

  if last_month is null then
    last_month := date_trunc('month', now())::date;
  end if;

  v_date_to := coalesce(
    nullif(params->>'date_to','')::date,
    last_month
  );

  v_date_from := coalesce(
    nullif(params->>'date_from','')::date,
    (v_date_to - interval '11 months')::date
  );

  v_metric := coalesce(nullif(params->>'metric',''), 'mrr');
  v_currency_mode := coalesce(nullif(params->>'currency_mode',''), 'system');

  v_group_by := coalesce(
    (select array_agg(value::text) from jsonb_array_elements_text(coalesce(params->'group_by','["period_month"]'::jsonb))),
    array['period_month']
  );

  v_filters := coalesce(params->'filters', '{}'::jsonb);

  -- Compat default para chatbot: si no se especifica is_total_row, NO filtrar por total row.
  if v_filters ? 'is_total_row' is false then
    v_filters := jsonb_set(v_filters, '{is_total_row}', 'false'::jsonb, true);
  end if;

  return query
  select *
  from public.rsm_metrics(
    v_date_from,
    v_date_to,
    v_metric,
    v_currency_mode,
    v_group_by,
    v_filters
  );
end;
$function$

