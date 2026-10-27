# Cambio: número de contrato único sin distinguir mayúsculas (4a) y RENEWAL conservada al editar el borrador (4c)

> **Rama:** `domi` · Domi 26-10-2026 · plan de la semana del 19-10, punto 4 (4b, RUT duplicado y eliminar razón social, ya estaba en prod; Domi lo revisa aparte).
> **Sin migración ni cambios de datos** (el índice case-insensitive quedó pendiente, ver 4a). Sin cambios en el front salvo dos líneas de ayuda.

## 4a · Correlativo

- **Qué pasaba.** El correlativo secuencial y el índice único por holding existen desde el 01-10, pero comparaban texto exacto: en producción
  conviven "ctr-2026-218" (Avon CARD, borrador "En revisión" creado en el front viejo el 09-09, sin facturas) y "CTR-2026-218" (Cuestamoras,
  activo). Los otros 370 números "no estándar" de SimpliRoute (hex viejos, sufijos, "CTR-2026-Salvador") son manuales válidos.
- **API** (`contract-drafts.service.ts`): el número manual se recorta y se rechaza con 409 si ya existe sin distinguir mayúsculas, nombrando
  el existente tal como está escrito; se guarda como se escribió (no se normaliza a mayúsculas). El generador (`nextCorrelative`) cuenta los
  que calzan el patrón sin distinguir mayúsculas (`regexp_match(..., 'i')` + `~*`): un "ctr-2026-300" escrito a mano ocupa el 300.
  Verificado en producción que el próximo correlativo de SimpliRoute no cambia (230 con ambas reglas).
- **Índice, pendiente (decisión de Domi 27-10)**: `contracts_holding_number_unique` sigue siendo sensible a mayúsculas. Para pasarlo a
  `lower(contract_number)` hay que resolver antes el único par de producción: CTR-2026-218 (Cuestamoras, 08-09) y ctr-2026-218 (Avon CARD,
  09-09), ambos activos con facturas y con una factura de Avon en Odoo (A10146, 23-10) que lleva "ctr-2026-218" como origen. Renumerar
  con una migración desalinearía Sapira y Odoo, así que esa migración se escribió y se retiró de este bloque; se hará cuando Domi decida
  el caso (renumerar avisando a SimpliRoute y corrigiendo el origen en Odoo, o dejarlo). Mientras tanto la regla la aplica la API.

## 4c · RENEWAL al editar el borrador

- **Qué pasaba.** `PUT /contracts/:id` (borrador) recalcula la categoría de cada ítem existente (`itemCategoriaSql`) salvo que el cuerpo
  traiga una explícita, y el front no la manda: cualquier edición borraba RENEWAL (la marcan Datos históricos y el arranque rápido; el
  motor nunca la calcula). En producción, 14 de los 16 borradores tienen ítems RENEWAL; solo hubo una edición (CTR-2026-228, NEW), nada
  se perdió aún.
- **API** (`updateItem`): `categoria = COALESCE($33, CASE WHEN categoria = 'RENEWAL' THEN categoria ELSE <recalculada> END)`. Las demás
  categorías siguen recalculándose (cambiar cliente o producto corrige NEW/UPSELL/CROSS-SELL); los ítems nuevos de la edición se calculan
  como siempre.

## Specs

`contract-drafts.service.spec.ts`: número manual repetido sin distinguir mayúsculas (409 nombrando el existente, recorte de espacios),
generador con `regexp_match` insensible, UPDATE del ítem que conserva RENEWAL.

## Impacto

- 4a toca solo la creación de contratos (alta, desde cotización y Datos históricos pasan por `reserveNumber`); ningún dato cambia.
  4c toca solo el PUT de borradores sin facturas.
- Ayuda: "Crear un contrato" (número único sin distinguir mayúsculas) y "Relacionar o crear contrato" de Datos históricos (la
  categoría Renovación se conserva al editar).
