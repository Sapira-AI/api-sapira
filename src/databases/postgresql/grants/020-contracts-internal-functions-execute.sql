-- Quita el EXECUTE a PUBLIC, anon y authenticated de funciones de contratos que solo deben correr
-- desde otra función, nunca por `supabase.rpc()`.
--
-- `recalc_revenue_for_contract(uuid)` — la llama `approve_contract_amendment` (rama CROSS_SELL,
-- viva vía `create_contract_cross_sell`). Su único llamador rpc del front viejo era
-- `useAmendmentApprovals`, cargado solo por `AmendmentApprovalsModal`, que ninguna página monta
-- (se borró en el saneamiento del 24-09). Logs del gateway 25-08 → 24-09: 0 llamadas por rpc.
-- Pese al nombre, **solo borra** `contract_invoices` editables: expuesta a `anon` con SECURITY
-- DEFINER, cualquiera con la anon key podía borrar cronogramas de cualquier holding.
--
-- No se borra: `approve_contract_amendment` es SECURITY DEFINER y la invoca como su dueño, así que
-- el REVOKE no la afecta. Se retira cuando el cross-sell se porte a la API (auditoría §2a, FUSIONAR).
-- Registro: `docs/v2-rediseno/saneamiento-contratos.md`.

REVOKE ALL ON FUNCTION public.recalc_revenue_for_contract(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_revenue_for_contract(uuid) TO service_role;
