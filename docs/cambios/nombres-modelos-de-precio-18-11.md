# Modelos de precio: nombres únicos, sin "cantidad fija o medida", y Por unidad desde la pantalla (18-11)

Origen: bug de soporte del 18-11 (SimpliRoute, Ransa Bolivia CTR-2026-425Bolivia) y decisión de Domi del mismo día, después de
comparar los modelos de Sapira con dos referencias de mercado.

## El bug

El editor de precio del front (`PrecioItemEditor`) no dejaba un producto en el modelo simple por consumo (`standard` + `metered`):
al elegir "Estándar" forzaba `quantity_type = 'fixed'` y no mostraba ni el selector de cantidad ni la métrica. La API siempre lo
aceptó (`price { model: 'standard', quantity_type: 'metered', billable_metric_id, unit_amount }`) y hay 133 ítems así en producción
(105 contratos, creados por migración o por API), pero desde la pantalla no se podía crear ni corregir. La usuaria corrigió el modelo
tres veces por "Corregir un dato mal cargado › El modelo de precio" y el producto siempre quedaba con cantidad fija.

## Decisión de Domi (18-11)

Cada modelo tiene **un solo nombre** en todas las pantallas, y ya no se elige aparte "cantidad fija o medida":

| Nombre | Qué cobra | `PriceSpec` |
|---|---|---|
| **Fijo** | Cantidad acordada × precio unitario. No depende del consumo; si cambia, es upselling o downselling | sin `price`, o `standard` + `fixed` |
| **Por unidad** | Consumo del período × precio por unidad (acepta precio unitario distinto por período, 13-11) | `standard` + `metered` |
| **Por tramos** | Cada tramo a su precio | `graduated` |
| **Por volumen** | Todo el consumo al precio del tramo alcanzado | `volume` |
| **Por paquete** | Bloques completos de N unidades | `package` |
| **Por asiento** | Asientos del período con un mínimo | `seat` |

- "Estándar" deja de usarse como nombre (antes: "Estándar" en Contratos y ayuda, "Fijo" / "Por unidad" en Precios, "fijo" en un
  mensaje de la API, "Escalonado" en una píldora).
- Fijo es el único que cobra la cantidad acordada. Todo otro modelo cobra el consumo de una **métrica facturable** obligatoria.
- **Cantidad fija con un modelo de precio** (tramos, volumen, paquete, asiento) era transitoria desde el 30-09
  (`spec-pricing-v2.md` §6): se retira de la pantalla. La API la sigue aceptando; no se cambió ninguna validación.
- "Porcentaje · Después" se oculta hasta que exista.

## Qué cambió

**API (solo textos; sin cambios de contrato, validación ni base de datos):**

- `priceModelName(model, quantity_type)` en `pricing-engine.ts`: "fijo", "por unidad", "por tramos", "por volumen", "por paquete",
  "por asiento". Lo usan las descripciones del historial de `price_model_change` ("pasa a precio por unidad desde el …") y de la
  corrección del modelo ("fijo → por unidad"), que antes decían "estándar" y "estándar por consumo".
- Mensaje de modelo inválido: "Elige el modelo de precio: fijo, por unidad, por tramos, por volumen, por paquete o por asiento".
- Mensaje del precio unitario del período en un modelo que no lo admite: "… solo se informa en ítems con precio Fijo o Por unidad …".

**Front** (detalle en `front-sapira/app/(protected)/contratos/README.md` → "Modelo de precio" y
`docs/reglas-desarrollo/modulos-en-construccion.md` → "Nombres de los modelos de precio"):

- `PRICE_OPTION_META` (seis opciones) es la fuente única de nombres; `pricingForOption` conserva la métrica entre modelos por consumo.
- Puertas cubiertas: contrato nuevo y cotización (`ItemRow`), agregar producto en un cambio, "Cambiar el modelo de precio",
  "Corregir un dato mal cargado › El modelo de precio" y el catálogo de Precios ("Nuevo precio", filtros, pestaña Modelos de precio).
- Por unidad pide métrica y precio por unidad (`pricing.unit_amount`) y deja el cobro en Vencido.

## Impacto (producción, solo lectura, 18-11)

| Qué | Cuántos |
|---|---|
| Ítems vivos sin modelo de precio (se ven como **Fijo**) | 1.211 en 754 contratos |
| Ítems `standard` + `metered` (se ven como **Por unidad**) | 133 en 105 contratos, un holding |
| Ítems `graduated` / `volume` por consumo | 1 y 1 |
| Precios con modelo distinto de `standard` y cantidad fija (lo que se retira de la pantalla) | **0** (contratos, catálogo y cotizaciones) |
| Precios de catálogo | 0 |

No se migra ni se reescribe ningún dato: los nombres internos (`standard`, `quantity_type`) no cambian. Si apareciera un modelo
guardado con cantidad fija (por ejemplo en QA), el front lo muestra con su modelo y, al editarlo, pide la métrica; mientras no se
edite, sigue facturando igual. CTR-2026-425Bolivia ya estaba en `standard` + `metered` (Vehículos, 19, Vencido) al 18-11.

## Lo que tienen las referencias y Sapira no (candidatos, sin decidir)

- **Prepago con excedente**: unidades comprometidas cobradas por anticipado y el exceso, vencido (hoy: mínimo comprometido en monto,
  con ajuste al cierre).
- **Tramos que se acumulan durante el plazo** del contrato en vez de reiniciarse cada período.
- **Porcentaje** sobre un monto transado (simple, por tramos y por volumen).
- **Matriz** (precio según un atributo del consumo, como región) y **fórmula libre**.
- **Cantidad fija con tramos o volumen** (licencias contratadas con descuento por volumen, cobradas por anticipado): las dos
  referencias la mantienen. Hoy se carga como Fijo con el precio ya calculado; volver a ofrecerla es solo front.

Sapira tiene además Por paquete y unidades gratis como campo propio, que esas referencias no traen.
