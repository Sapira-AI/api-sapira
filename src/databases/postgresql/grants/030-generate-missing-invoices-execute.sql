-- Quita el EXECUTE a PUBLIC, anon y authenticated de `generate_missing_invoices_for_contract(uuid)`: el generador legacy
-- de facturas solo debe correr desde el trigger de generación, nunca por `supabase.rpc()`.
--
-- Es SECURITY DEFINER y estaba expuesta a `anon` (QA 30-09: anon y authenticated con EXECUTE): cualquiera con la anon key
-- podía materializar facturas de cualquier contrato de cualquier holding. Auditoría §1, plan de coexistencia §3 paso 2,
-- `docs/v2-rediseno/activacion-costura-triggers.md`.
--
-- Llamadores en la base: `trigger_generate_invoices_on_contract_signed` (trigger `unified_generate_invoices_on_contract_signed`,
-- SECURITY DEFINER desde la costura) y `bulk_restructure_contract_start_dates` (SECURITY DEFINER): la invocan como su dueño y
-- el REVOKE no los afecta.
--
-- ORDEN: aplicar DESPUÉS de `functions/trigger_generate_invoices_on_contract_signed.sql` (si no, el front viejo no podría
-- activar: su trigger correría como `authenticated`).
--
-- ⚠️ NO APLICAR SIN OK DE DOMI. El front viejo (`sapira-ai`, 30-09) todavía la llama por rpc desde código MONTADO:
--   - `components/contratos/legacy/components/LegacyContractActivationModal.tsx:161` (pestaña Legacy: `ContratosLegacyTab`,
--     montada en `pages/contratos/components/ContratosTabs.tsx`);
--   - `components/contratos/hooks/useContractInvoiceGeneration.ts:12` (`GenerateMissingInvoicesButton`; verificar si se monta).
-- Antes de aplicar: logs del gateway `/rest/v1/rpc/generate_missing_invoices_for_contract` de 30 días y decidir entre quitar
-- esos llamadores en `sapira-ai` o esperar la baja. Si hay llamadas, este REVOKE rompe la activación legacy.

REVOKE ALL ON FUNCTION public.generate_missing_invoices_for_contract(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_missing_invoices_for_contract(uuid) TO service_role;
