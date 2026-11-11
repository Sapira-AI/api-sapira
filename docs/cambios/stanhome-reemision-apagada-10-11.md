# Stanhome · la reemisión nace apagada y con fecha elegible; aviso de NC en México (Domi 10-11)

Brief: `brief-soporte-10-11-stanhome-brightcell.md`, gap 2. Caso: A10198 anulada y reemplazada por A10216, emitida el mismo día por la
emisión automática y cancelada en el SAT.

## Qué pasaba

"Anular y reemplazar" creaba la reemisión con emisión hoy y con la emisión automática vigente del contrato (decisión del 02-11, CTR-2026-419):
si estaba encendida, la reemisión se timbraba ese día sin revisión. El panel no dejaba elegir la fecha aunque la API ya aceptaba
`reissue_changes.issue_date`. El aviso "emite la nota de crédito en el ERP" también salía en México, donde el CFDI se cancela ante el SAT sin NC.

## Cómo queda (decisión de Domi 10-11: opción a, "nace apagada")

- **API** (`invoice-void.ts`, `planReissue`): la reemisión nace con `auto_invoice = false`; un `auto_invoice: true` explícito en
  `reissue_changes` manda. Avisos: `reissue_auto_invoice_off` (si el contrato o la anulada la tenían encendida: "revísala y envíala al ERP
  cuando corresponda, o enciéndela desde Editar factura") y `reissue_sends_today` (encendida explícita con fecha de hoy o anterior). El
  contexto sigue cargando `auto_invoice` del contrato (solo para el aviso).
- **API, aviso por país**: `creditNoteToErpWarning(company_country, 'void' | 'discount')` reemplaza los dos textos fijos de
  `credit_note_to_erp` (anulación y NC de descuento): México → "cancela el CFDI ante el SAT (en México no lleva nota de crédito)…"; resto →
  el texto de antes.
- **Front** (`AnularFacturaDialog`, `factura-nc-oc.ts`): campo **Fecha de emisión de la reemisión** (vacía = hoy) que viaja en
  `reissue_changes.issue_date`; el texto del interruptor dice que la reemisión nace con la emisión apagada. Los avisos se muestran como los demás.

## Tests

- `invoice-void.spec.ts`: nace apagada con y sin aviso, true explícito con fecha hoy / pasada / futura, fecha elegida, texto de México
  (anulación y descuento) y de Chile.
- Front: `factura-nc-oc.test.ts` (`buildVoidBody` con fecha) y `nc-oc-dialogos.test.tsx` (la fecha elegida viaja en el body).

## Docs

Spec facturas 360 §3.8; ayuda `notas-de-credito-y-facturar-por-oc.md` y `facturas-del-contrato.md`; novedad del 10-11 de emisión automática
corregida (la reemisión ya no hereda el interruptor).

## Impacto

Cambia el valor con que nace toda reemisión (contratos con emisión automática encendida: antes se emitía sola, ahora espera revisión). Es
lo que pidió Domi para evitar timbres sin revisar; el envío manual y "Editar factura" siguen permitiendo encenderla. Sin migración ni datos
tocados; las reemisiones ya creadas no cambian.
