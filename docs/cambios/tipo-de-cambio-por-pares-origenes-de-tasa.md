# Cambio: la tasa que ya tiene una línea se respeta al emitir por significado, no por lista de orígenes

> **Rama:** `domi` · Domi 23-10-2026 · caso Carelis, unificada Brightcell `4f6c2905` (CTR-2026-110, contrato fijo, líneas USD → CLP y UF → CLP).
> Sin migraciones ni cambios de datos.

## Qué pasaba

"Enviar al ERP ahora" fallaba con "Falta el tipo de cambio para valorizar la factura en su moneda" aunque todas las líneas tenían tasa y
montos en CLP. En la valorización por pares (`calculatePairAmountsAtIssue`) la tasa de una línea solo se conservaba si su
`fx_rate_source` estaba en `KEPT_FX_SOURCES` (`contract`, `manual`, `net_exact`, `manual_unify`). La línea de Agentes AI venía con
`contract-change` (Modificar contrato) → no se conservaba → con política fija pasaba a "falta la tasa". Se destrabó por datos pasando
4 líneas a `contract`. El mismo defecto afectaba a 5 unificadas más Por Emitir en producción (CTR-2026-110 con líneas NULL,
CTR-2026-125-PATH con `scheduled-generation`).

Las otras cuatro listas del código coincidían ("tasa fijada por factura" = `manual`, `net_exact`): `PER_INVOICE_FX_SOURCES`
(Modificar contrato), `DOCUMENT_RATE_SOURCES` (revalorizar por par), `EXPLICIT_FX_SOURCES` (restablecer borrador) y `explicitlyFixed`
(scheduler, una moneda). Solo la del scheduler por pares mezclaba ese concepto con "tasa que se respeta al emitir".

## Qué cambia

1. **Módulo hoja `src/modules/contracts/fx-rate-sources.ts`** (sin imports): inventario de todos los orígenes que escribe la API y qué
   significan, `PER_INVOICE_FX_SOURCES`, `CONTRACT_FX_SOURCES`, `SPOT_FX_SOURCE` y `keepsRateAtIssue(origen, tasa, políticaFija)`.
   Modificar contrato, multimoneda, la vista rápida y el scheduler importan de ahí (las cuatro listas que coincidían no cambian de valor).
2. **Regla por significado** en la valorización por pares:
   - sin tasa, o con la marca `spot`: no se conserva (se valoriza al día; con contrato fijo, falta);
   - contrato **fijo** (sin "Del día" elegido): toda línea con tasa la conserva, sea cual sea su origen (igual que la rama de una moneda,
     que usa la tasa que haya);
   - contrato **spot**: solo las fijadas por factura (`manual`, `net_exact`, `manual_unify`) y las del contrato (`contract`,
     `contract-change`); el resto se valoriza al día como hasta ahora. `contract-change` es lo único que se suma respecto a antes.
3. **Error con el par** (`erp-error-translation.ts`, `missingFxPairs`): "Falta el tipo de cambio para USD → CLP y CLF → CLP" en vez de la
   frase genérica, cuando el texto técnico del scheduler nombra los pares. Mismo paso siguiente y acción.
   Reconoce los tres textos (scheduler por pares, scheduler simple y servicio de tasas "No se encontró tipo de cambio para USD/CLP en o
   antes de…") y solo códigos de moneda en mayúsculas y completos ("para esa línea" no cuenta; revisión 23-10).

Qué no cambia: la rama de una moneda del scheduler; Modificar contrato sigue sin pisar las tasas `manual`/`net_exact`; la revalorización por
par sigue usando solo esas como tasa del documento; "Del día" elegido sigue mandando sobre el contrato fijo (22-10).

## Specs

`fx-rate-sources.spec.ts` (regla por política y origen), `invoice-scheduler.service.spec.ts` (contrato fijo con `scheduled-generation`,
`contract-change` y NULL conserva sin Banco Central; sin tasa → `fx_rate_missing` con `USD → MXN`; spot con `reissue` se valoriza al día y
con `contract-change`/`manual` se conserva), `erp-error-translation.spec.ts` (pares en el mensaje). Suites de contratos, cambios,
multimoneda y scheduler verdes.

## Pendientes de la revisión del 23-10 (no incluidos aquí)

- `planSendNow` y el 360 deciden `fixed_fx_without_rate` por el `fx_contract_to_invoice` del encabezado, que es NULL con dos o más pares
  aunque todas las líneas tengan tasa (falso bloqueo en multimoneda fija; 0 casos en producción hoy). Decidir por par cuando hay líneas en
  otra moneda.
- Una línea marcada `spot` vuelve spot la regla de toda la factura en la rama por pares (mezcla si otra línea recibe tasa después).
- Tres alias del mismo conjunto (`EXPLICIT_FX_SOURCES`, `DOCUMENT_RATE_SOURCES`, `PER_INVOICE_FX_SOURCES`) y `manual_unify` como literal
  suelto en `fx-rate-sources.ts`.

## Impacto

- Toca solo el envío al ERP de facturas valorizadas por par (multimoneda o unificadas con más de un par), el texto del error y los imports
  de las listas. Producción: 5 unificadas Por Emitir se destraban por código; las 4 líneas que se pasaron a `contract` a mano quedan bien.
  COL-01 (holding 49763a7a, una moneda) no pasa por esta rama.
- Sin escrituras en producción.
