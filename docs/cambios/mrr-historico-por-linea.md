# MRR histórico por línea de factura (Domi 28-10)

Datos históricos › Registrar histórico (y Editar registro, la importación con histórico y el arranque rápido) registraban el MRR histórico
**por factura**: un período, una moneda de contrato y un reparto por producto para toda la factura, con todas las filas colgadas de la
primera línea (`invoice_items_legacy`). La carga inicial de SimpliRoute y el modal del front anterior lo hacían **por línea**: cada línea de
la factura con su producto, su moneda pactada, su período y su `split_index` 1. El caso que no cabía en v2: una factura cobrada en una
moneda con líneas de contratos pactados en monedas distintas (Enveese: factura ARS con una línea pactada en ARS y otra en USD).

## Qué cambia

- **A · Registro por línea.** `RegisterHistoryInvoiceDto` pasa a `{ invoice_id, target_key?, lines[{ item_id, period_from, period_to,
  contract_currency, amount_contract_currency, is_recurring?, products[], target_key? }] }` (`RegisterHistoryLineDto`). El motor
  (`OnboardingRegisterService.plan`) arma un plan **por línea**: `invoice_item_legacy_id` = la línea, tipo de cambio = subtotal de la línea
  ÷ monto en moneda de contrato, `split_index` = posición del producto después de los ya usados en esa línea (dividir una línea en varios
  productos sigue existiendo). Un evento `history_registered` por línea (con `item_id`, `item_index`, `item_description`). La vista previa
  devuelve `rows[].lines[]` y la unión de avisos/errores por factura; `summary` cuenta líneas y facturas.
- **B · Import por línea y opcional.** Se quitó la validación "todas las líneas comparten período, moneda y recurrencia". Cada línea de la
  hoja Items que trae el histórico completo registra el suyo (`registerInputOf` → una línea de registro por línea, con los ids que devuelve
  `INSERT … RETURNING id`); una línea sin ninguno de esos campos entra solo como línea de la factura; una a medias deja la factura
  `incomplete`. `ImportRowHistory.lines[]` trae producto, moneda y tipo de cambio por línea.
- **C · Registro parcial.** `already_registered` es por línea: tiene filas propias, o la factura está registrada entera (sus filas cubren el
  neto ±1 %, el caso de las 57 facturas registradas por factura antes de esta regla). Las demás líneas se registran después. La lista y
  el detalle de facturas previas traen `history_partial` y `items[].has_history`.
- **D · Registros.** Sin cambio de claves: una factura con líneas en dos monedas de contrato abre dos registros (uno por moneda), como las
  138 facturas de la carga inicial. Unirlos en un contrato multimoneda queda para después.
- **E · Compañía emisora en el import.** `PreviousInvoiceInputDto` acepta `company_tax_id` y `company_country`. Orden: identificador fiscal
  → nombre + país → nombre + moneda de la factura → nombre único. Si sigue ambiguo, el error nombra los países de las candidatas y las dos
  columnas (caso SimpliRoute S.A.S × 3: UY, AR, CO).
- **Editar registro** (`editContext`): por línea (`invoices[].lines[]`), con el monto en moneda de factura que el registro tenía asignado
  a cada línea como base del tipo de cambio; los errores apuntan a `invoices.<i>.lines.<j>`. `GET /onboarding/history/lines/:key` devuelve
  `invoices[].lines[]` con el registro de cada línea (y conserva `registration` de la factura entera).
- **Arranque rápido**: sin cambio de contrato; registra la última factura entera como una sola línea colgada de su primera línea, con el
  neto como monto en moneda de factura (`firstItemIds` + `lineAmounts`).

## Impacto

- **Quién más lo usa.** `onboarding-register.service.ts` (motor), `onboarding-history.service.ts` (Editar registro, detalle),
  `onboarding-previous-invoices.service.ts` (import, lista, detalle), `onboarding-quick-start.service.ts`, `onboarding-line-edit.ts`,
  `onboarding.controller.ts` (Swagger). Métricas no cambia: las filas de `mrr_legacy` conservan su forma (producto, moneda y período en la
  fila). Front: `app/(protected)/datos-historicos` (Registrar histórico, Editar registro, importación, plantilla, chips) y
  `lib/schemas/onboarding-schemas.ts`.
- **Cuántos registros reales toca.** Ninguno se migra. Prod (SimpliRoute): 8.820 facturas con histórico / 12.109 filas, todas con línea;
  1.506 facturas de varias líneas ya registradas por línea por la carga inicial; 57 facturas de varias líneas registradas por factura por v2
  (todas sus filas en la primera línea, ninguna con líneas en distinta moneda) quedan como están y se ven "Registrado" (cubren el neto);
  138 facturas con histórico en dos monedas de contrato siguen con sus dos registros. Enveese/Food Packaging viven en QA, no en prod.
- **Qué lo verifica.** `onboarding-previous-invoices.service.spec.ts` (registro por línea con dos monedas, dividir una línea, registro
  parcial, factura registrada entera, `item_not_found`/`duplicate_line`, import por línea y opcional, compañía por RUT/país/ambigua),
  `onboarding-history.service.spec.ts` (edición por línea, detalle con `lines[]`), `onboarding-quick-start.service.spec.ts`,
  `onboarding.http.spec.ts` (body por línea, 400 con campo). Front: `registro.test.ts`, `editar-linea.test.ts`,
  `RegistrarHistoricoDrawer.test.tsx`, `plantilla-facturas.test.ts`, `onboarding-schemas.test.ts`.
- **Qué doc cambia.** `docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` (§3.2b, §5), esta nota; en el front el centro de ayuda
  (Registrar el MRR histórico, Importar facturas previas) y la novedad "El MRR histórico se registra por línea".
