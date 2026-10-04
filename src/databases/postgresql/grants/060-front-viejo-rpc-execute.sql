-- Switch (04-10-2026, OK de Domi): quita el EXECUTE a PUBLIC, `anon` y `authenticated` de las funciones que solo llamaba el front
-- viejo (`sapira-ai`) por `supabase.rpc()`. Desde el switch ese front está bloqueado (`app.aisapira.com` redirige a `aisapira.com` y
-- su proyecto de Vercel pide login), pero su anon key y PostgREST siguen sirviendo `/rest/v1/rpc/*`: sin este REVOKE, lo que esas
-- funciones hacen (todas SECURITY DEFINER) se podía seguir haciendo con la anon key.
--
-- Medido en producción el 04-10-2026: las 30 son de `postgres`, SECURITY DEFINER, y `postgres` y `service_role` tienen EXECUTE
-- explícito. Quedan así:
--   - la API (rol `postgres`) y los triggers y funciones DEFINER que las encadenan (corren como su dueño) no se ven afectados;
--   - `service_role` conserva el EXECUTE: las edge functions que siguen (`check-overdue-invoices`, `refresh-pending-renewals`) usan
--     `mark_overdue_invoices` / `refresh_all_pending_renewals` con esa clave;
--   - pg_cron corre como `postgres`.
--
-- Fuera a propósito (no tocar sin decisión): las de sesión/tenancy que usan las RLS (`get_current_user_holding_id`, etc.), las del MRR
-- histórico (`create_contract_from_mrr_legacy`, `mark_mrr_legacy_skip_activation`: se reemplazan en el front nuevo) y el resto de §4
-- de `docs/v2-rediseno/switch-supabase-inventario.md` que se retira después del período de pruebas. `generate_missing_invoices_for_contract`
-- está en `030-generate-missing-invoices-execute.sql` (se aplica en el mismo paso).
--
-- Fuentes: `docs/v2-rediseno/switch-supabase-inventario.md` §4 y §6 paso 3, `docs/v2-rediseno/plan-coexistencia-funciones.md` §4.
-- Siguiente paso, tras las pruebas: DROP de las que ya no llama nadie.

-- Usuarios y alta de holding (front viejo: UserFormModal, EditRoleModal, Auth, useConfiguracionInicial). El alta de holding queda
-- manual hasta el onboarding v2 (decisión de Domi, 03-10).
REVOKE ALL ON FUNCTION public.invite_user_safe(uuid, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_user_role_safe(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_current_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_user_complete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_admin_role_safe(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_user_holding_association_safe(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Contratos (plan de coexistencia §4: las reemplazan los flujos v2 de la API).
REVOKE ALL ON FUNCTION public.bulk_activate_contracts(uuid[], text, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_contract_signed_safe(uuid, text, date, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.regenerate_contract_invoices_from_items(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_contract_cross_sell(uuid, jsonb, date, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_contract_amendment(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalc_revenue_for_contract(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_contract_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_quote_downsell_to_contract(uuid, uuid, jsonb, date, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_contract_contraction(uuid, text, jsonb, date, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_contract_renewal(uuid, date, integer, date, boolean, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_auto_renewals(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_auto_renewal_for_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_items_pending_auto_renewal(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_invoices_for_contract_item(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_reschedule_items(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_contract_item_continuity(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bulk_restructure_contract_start_dates(uuid[], date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_contract_currency(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_contract_commercial_client(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bulk_confirm_fx_policy(uuid[], text) FROM PUBLIC, anon, authenticated;

-- Crons y vencidas (inventario §0): solo pg_cron (`postgres`) y las edge con service role.
REVOKE ALL ON FUNCTION public.mark_overdue_invoices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manual_check_overdue_invoices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_all_pending_renewals() FROM PUBLIC, anon, authenticated;

-- `service_role` y `postgres` ya tienen EXECUTE explícito; se reafirma para que el asset sea completo por sí solo.
GRANT EXECUTE ON FUNCTION
	public.invite_user_safe(uuid, text, text, uuid, uuid),
	public.update_user_role_safe(uuid, uuid),
	public.delete_current_user(),
	public.delete_user_complete(uuid),
	public.assign_admin_role_safe(uuid),
	public.create_user_holding_association_safe(uuid, uuid),
	public.bulk_activate_contracts(uuid[], text, date, text),
	public.mark_contract_signed_safe(uuid, text, date, text, text[]),
	public.regenerate_contract_invoices_from_items(uuid),
	public.create_contract_cross_sell(uuid, jsonb, date, text, jsonb, boolean),
	public.approve_contract_amendment(uuid, boolean, text),
	public.recalc_revenue_for_contract(uuid),
	public.reconcile_contract_status(uuid),
	public.apply_quote_downsell_to_contract(uuid, uuid, jsonb, date, text, text),
	public.apply_contract_contraction(uuid, text, jsonb, date, uuid, text),
	public.create_contract_renewal(uuid, date, integer, date, boolean, jsonb, boolean),
	public.process_auto_renewals(integer),
	public.execute_auto_renewal_for_item(uuid),
	public.get_items_pending_auto_renewal(integer),
	public.sync_invoices_for_contract_item(uuid, text),
	public.invoice_reschedule_items(uuid, jsonb),
	public.check_contract_item_continuity(uuid),
	public.bulk_restructure_contract_start_dates(uuid[], date),
	public.change_contract_currency(uuid, text),
	public.change_contract_commercial_client(uuid, uuid),
	public.bulk_confirm_fx_policy(uuid[], text),
	public.mark_overdue_invoices(),
	public.manual_check_overdue_invoices(),
	public.refresh_all_pending_renewals()
TO postgres, service_role;
