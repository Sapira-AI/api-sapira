# Rebuild del devengo: comparación antes/después (SimpliRoute, TiMining, uPlanner)

> 04-10-2026 · Copia local de producción (`pg_dump` del esquema `public` del 04-10 a las 09:40, solo lectura) restaurada en un
> Postgres 15 temporal. **Nada se ejecutó en producción ni en QA.** Montos en moneda de sistema (la misma en los tres holdings), sin
> suscripciones de Stripe. Script reproducible: `scratchpad/pg-rebuild/run-all.sh` (pasos `01`–`14`, ver §8).
> Contexto: [`estado-v2-y-plan-switch.md`](./estado-v2-y-plan-switch.md) §5 punto 3, [`cobertura-contratos-v2.md`](./cobertura-contratos-v2.md) §6,
> [`auditoria-datos-switch.md`](./auditoria-datos-switch.md), [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md) §1.

## 1. Resumen

**Qué se corrió.** `revenue_schedule_rebuild(contrato, p_from_month)` sobre los 674 contratos de los tres holdings (todos los estados,
incluidos los que tienen ítems mal cargados: el rebuild recalcula su devengo; **los ítems de contrato no se tocaron**). `p_from_month` =
primer día del mes siguiente al cierre vigente de la compañía (`accounting_period_cutoff.cutoff_date`): SimpliRoute CLP y PEN desde
2025-01, UYU desde 2025-07, COP desde 2025-09 (445 contratos con rebuild parcial); el resto (MXN de SimpliRoute, TiMining y uPlanner)
rebuild completo. Las funciones de la copia son **idénticas a los assets del repo** (fixes RSM 01-10 U8, S5-16, U5 y S5-10 ya están en
producción: `revenue_schedule_rebuild`, `_contract_ccy`, `apply_fx_for_contract`, `apply_pending_renewal_tail`, `apply_renewal_price_split`,
`nc_discount_revenue_adjustment`, `contract_item_fx_rate` y el trigger `trg_assign_momentum`).

**Resultado técnico.** 674 de 674 contratos sin error (6,5 s en total, máx. 0,4 s por contrato). 3.001 filas de suscripciones intactas.
Filas de contratos: SimpliRoute 7.557 → 7.806, TiMining 4.617 → 4.683, uPlanner 4.988 → 4.988. Ninguna fila de meses cerrados cambió
(no hay filas RSM en los meses cerrados de SimpliRoute). Para los 445 contratos con rebuild parcial, un rebuild completo da exactamente
las mismas filas desde el mes de inicio (5.773 filas, 0 diferencias): U8 está resuelto.

| Holding | Contratos | Con alguna diferencia | Cambia MRR | Cambia reconocido | Cambia facturado | Cambian saldos | Cambia pendiente de renovar |
|---|---:|---:|---:|---:|---:|---:|---:|
| SimpliRoute | 567 | 485 | 14 | 84 | 419 | 484 | 0 |
| TiMining | 45 | 21 | 1 | 3 | 0 | 21 | 0 |
| uPlanner | 62 | 15 | 0 | 2 | 0 | 15 | 0 |

**Por holding, en una frase** (a sep-2026):

- **SimpliRoute**: el MRR de contratos sube 16.797 USD/mes **solo por 13 contratos "En revisión"** que hoy no tienen devengo y el rebuild
  se los crea (ver decisión D1); el facturado del mes pasa de 205.518 a 323.306 (el RSM tenía 1.438 ítem-mes con facturas no reflejadas en
  420 contratos; después quedan 2, ambos facturas emitidas antes del inicio del contrato); diferido 302.495 → 25.670 y por facturar
  1.017.428 → 831.732 (acumulados U8 + facturas). El reconocido baja en 65 contratos con **overrides** (`quantities`), que el rebuild no lee
  (ver decisión D2).
- **TiMining**: MRR igual. Reconocido +313 a +3.571 por mes (prorrateo del primer mes recalculado con S5-16/U5 en 5 contratos). Diferido 2.988.057 → 553.597 y por facturar
  93.125 → 311.684: el diferido guardado estaba inflado por rebuilds parciales anteriores a U8 en 20 contratos (acumulado devengado
  reiniciado en 0).
- **uPlanner**: MRR y reconocido iguales desde 2026-07 (+1.464–1.500 en 2025–2026-06 por prorrateo de un ítem). Diferido 1.513.917 → 782.491
  y por facturar 529.563 → 706.036: mismo efecto U8 en 13 contratos. Los meses 2027 del "antes" traen filas sin tasa del sistema
  convertidas a 1,0 (COP como USD, hasta 362 millones de "diferido"); después quedan sin convertir (NULL), como define S5-10.

**Requiere decisión de Domi antes de aplicar en producción**

| # | Tema | Qué pasa | Propuesta |
|---|---|---|---|
| D1 | **Contratos "En revisión"** (14 en SimpliRoute; 13 sin devengo hoy) | El rebuild les crea devengo con MRR (16.797 USD/mes en 2026) y Métricas no filtra por estado: entrarían al MRR antes de activarse. Los 13 son destino de MRR legacy (`migrated_to_contract_id`), así que el corte U14 además quita 3.946–4.659 USD/mes de legacy en 2026-05..08 | **Excluirlos del rebuild** (v2 crea el devengo al activar). Alternativa: incluirlos solo si Métricas filtra contratos no activados |
| D2 | **Overrides (`quantities`) del front actual** | 315 overrides en 78 contratos de SimpliRoute; 238 difieren del plan. Antes el devengo de 191 seguía el override (el trigger `trg_rsm_on_quantity_change`); el rebuild vuelve todos al plan (237). Las facturas sí siguen el override (222 de 238), así que la diferencia pasa a diferido/por facturar. Impacto en reconocido: 68.641 USD brutos, −4.163 netos, en 65 contratos (2025-12 → 2026-12). El MRR v2 (plan) no cambia | Antes de aplicar, que `revenue_schedule_rebuild_contract_ccy` use el override del período como devengo del mes (como hoy hace el path legacy y como pide R8 para consumos), o aplicar `revenue_schedule_update_period_quantities` después del rebuild para esos ítem-mes. Sin eso, **excluir los 65 contratos** del lote |
| D3 | Facturas emitidas **antes del inicio** del contrato | 10 ítem-mes (SimpliRoute CTR-2026-02 y S06821; uPlanner 194, 200, 218, 221): el monto entra al acumulado (diferido correcto) pero ningún mes muestra ese facturado. Igual antes y después | Dato o regla: corregir la fecha de emisión / inicio, o que el rebuild arranque en el mes de la primera factura (como ya hace con las posteriores al fin) |
| D4 | Ajustes con fin a mitad de ciclo | El rebuild prorratea solo el primer mes y nunca al final (correcto según la regla), así que un UPSELL que empieza a mitad de ciclo y termina a mitad de ciclo deja sin reconocer el tramo final (p. ej. CTR-2026-61: 0,32 meses de 4.674.000). 16 ajustes con fin a mitad de ciclo y 42 que pasan el fin de los ítems base (anexo C) | Corregir las fechas en la corrección de datos (no ahora) y repetir el rebuild de esos contratos |
| D5 | Tipo de cambio faltante | Sin tasa del sistema para 2027+ en COP/CLF/MXN (uPlanner, TiMining) y sin tasa de compañía USD→UYU desde 2026-11, USD→CLP/COP/PEN/MXN desde 2028: esas filas quedan NULL y fuera de los totales (antes algunas se sumaban × 1,0) | Cargar las tasas en la corrección de datos; el rebuild posterior las completa |

**Actualización 04-10 · decisiones definitivas de Domi.** **D2 y D3 se corrigen en código** (`revenue_schedule_rebuild_contract_ccy`
v3.7, asset sin aplicar fuera de la copia): el override del período es el devengo del mes con la regla de la factura (D2), y las
facturas emitidas antes del inicio son datos históricos válidos: el rebuild arranca en el mes de la primera factura (D3). **D1 no va en
código y el rebuild procesa los datos como están, sin excluir nada**: corre sobre todos los contratos del holding (también En revisión /
Borrador); después Domi revisa las anomalías (§9.4), corrige datos en otra sesión y se vuelve a correr. Cifras en **§9 (Corrida final)**,
con todas las funciones de tipo de cambio del árbol (tasa proyectada solo hacia adelante) y las migraciones F1 y de retiro de triggers;
el procedimiento de §7 ya lo incluye. Las tablas de §3–§6 son la corrida 1 (funciones de producción); §10 es la corrida 2 (solo D2), superada.

Los ítems negativos (bajas y contracciones del modelo anterior) **se recalcularon igual** y no cambian con el rebuild; quedan listados
en el anexo B para la corrección de datos.

## 2. Cómo se midió

- **Alcance**: `contracts` de los holdings (sin borrados; no hay contratos borrados en los tres) → SimpliRoute 567 (499 Activo, 54 Cancelado,
  14 En revisión), TiMining 45, uPlanner 62. Filas RSM de suscripciones (`subscription_id`) fuera: el rebuild no las toca.
- **"Antes"**: copia de `revenue_schedule_monthly` de los tres holdings (`cmp.rsm_before`, 20.163 filas) tomada antes del rebuild.
- **Métricas, con las reglas de Métricas v2** (`metrics-data.service.ts`, spec revenue §1.2–§1.7):
  MRR = Σ `mrr_period_contracted_system_ccy` sin `PENDING_RENEWAL`; pendiente de renovar = las filas `PENDING_RENEWAL`; reconocido /
  facturado = Σ `recognized_period_*` / `billed_period_*`; **diferido y por facturar al cierre del mes por contrato** (último mes ≤ M de
  cada ítem, `net = Σ billed_cum − Σ recognized_cum`, diferido = max(net, 0), por facturar = max(−net, 0)). Filas sin convertir (monto
  NULL o `fx_to_system_source` `missing_fx_rate*`, salvo mes inactivo sin montos) fuera de los totales y, para saldos, el ítem entero
  fuera desde su primera fila sin convertir (igual que `loadRevenueRows`).
- **MRR legacy** (solo SimpliRoute tiene `mrr_legacy`): `mrr_legacy_system_currency` recurrente con el corte U14 (fuera la fila migrada en
  meses ≥ primer mes con MRR de su contrato), calculado con el RSM de antes y con el de después.
- Tablas de trabajo en el esquema `cmp` de la copia: `scope`, `rsm_before`, `rsm_after`, `rebuild_log`, `monthly`, `cm` (contrato × mes),
  `causes`, `chk_*`, `neg`, `adj`.

## 3. Por holding y mes (2025-01 → 2027-12)

"MRR total" de SimpliRoute = contratos + legacy con corte (sin suscripciones). TiMining y uPlanner no tienen legacy.
**Lectura de 2027 en TiMining y uPlanner**: el diferido "antes" de 34 y 362 millones viene de filas de meses posteriores al fin de ítems
COP/CLF/MXN sin tasa del sistema, que la versión anterior de `apply_fx` dejaba con el acumulado × 1,0 (COP como USD). Después esas filas
quedan NULL y sin convertir, así que los saldos de 2027 de esos holdings están **incompletos hasta cargar las tasas** (D5).

#### SimpliRoute · MRR (USD)

| Mes | MRR contratos antes | después | dif. | Legacy (corte U14) antes | después | dif. | MRR total antes | después | dif. | Pendiente de renovar antes | después |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-01 | 0 | 0 | 0 | 476.952 | 476.952 | 0 | 476.952 | 476.952 | 0 | 0 | 0 |
| 2025-02 | 0 | 0 | 0 | 518.755 | 518.755 | 0 | 518.755 | 518.755 | 0 | 0 | 0 |
| 2025-03 | 0 | 1.553 | 1.553 | 517.242 | 517.242 | 0 | 517.242 | 518.795 | 1.553 | 0 | 0 |
| 2025-04 | 0 | 1.553 | 1.553 | 557.341 | 557.341 | 0 | 557.341 | 558.894 | 1.553 | 0 | 0 |
| 2025-05 | 0 | 1.553 | 1.553 | 561.289 | 561.289 | 0 | 561.289 | 562.842 | 1.553 | 0 | 0 |
| 2025-06 | 0 | 1.553 | 1.553 | 532.798 | 532.798 | 0 | 532.798 | 534.351 | 1.553 | 0 | 0 |
| 2025-07 | 0 | 1.553 | 1.553 | 525.703 | 525.703 | 0 | 525.703 | 527.256 | 1.553 | 0 | 0 |
| 2025-08 | 0 | 1.553 | 1.553 | 501.499 | 501.499 | 0 | 501.499 | 503.052 | 1.553 | 0 | 0 |
| 2025-09 | 1.232 | 2.785 | 1.553 | 530.113 | 530.113 | 0 | 531.344 | 532.897 | 1.553 | 0 | 0 |
| 2025-10 | 1.233 | 3.092 | 1.859 | 582.405 | 582.405 | 0 | 583.637 | 585.497 | 1.859 | 0 | 0 |
| 2025-11 | 11.833 | 13.692 | 1.859 | 532.147 | 532.147 | 0 | 543.980 | 545.839 | 1.859 | 0 | 0 |
| 2025-12 | 14.838 | 16.697 | 1.859 | 540.018 | 540.018 | 0 | 554.855 | 556.714 | 1.859 | 0 | 0 |
| 2026-01 | 23.352 | 25.275 | 1.923 | 506.120 | 506.120 | 0 | 529.472 | 531.395 | 1.923 | 0 | 0 |
| 2026-02 | 25.958 | 31.827 | 5.869 | 504.791 | 504.791 | 0 | 530.749 | 536.618 | 5.869 | 44 | 44 |
| 2026-03 | 31.068 | 35.384 | 4.316 | 524.128 | 524.128 | 0 | 555.196 | 559.512 | 4.316 | 0 | 0 |
| 2026-04 | 66.632 | 71.661 | 5.029 | 508.013 | 508.013 | 0 | 574.644 | 579.673 | 5.029 | 0 | 0 |
| 2026-05 | 193.433 | 198.762 | 5.329 | 379.587 | 374.928 | −4.659 | 573.020 | 573.689 | 670 | 0 | 0 |
| 2026-06 | 294.610 | 311.407 | 16.797 | 228.719 | 224.774 | −3.946 | 523.329 | 536.181 | 12.852 | 0 | 0 |
| 2026-07 | 437.755 | 454.552 | 16.797 | 124.108 | 120.163 | −3.946 | 561.863 | 574.715 | 12.852 | 0 | 0 |
| 2026-08 | 512.090 | 528.888 | 16.797 | 79.574 | 75.629 | −3.946 | 591.665 | 604.516 | 12.852 | 0 | 0 |
| 2026-09 | 520.195 | 536.992 | 16.797 | 47.005 | 47.005 | 0 | 567.200 | 583.997 | 16.797 | 1.732 | 1.732 |
| 2026-10 | 516.437 | 532.939 | 16.503 | 46.343 | 46.343 | 0 | 562.780 | 579.283 | 16.503 | 3.657 | 3.657 |
| 2026-11 | 506.913 | 523.416 | 16.503 | 45.265 | 45.265 | 0 | 552.178 | 568.681 | 16.503 | 3.657 | 3.657 |
| 2026-12 | 500.119 | 516.622 | 16.503 | 44.658 | 44.658 | 0 | 544.778 | 561.280 | 16.503 | 3.657 | 3.657 |
| 2027-01 | 131.639 | 144.640 | 13.000 | 6.333 | 6.333 | 0 | 137.972 | 150.972 | 13.000 | 3.657 | 3.657 |
| 2027-02 | 130.117 | 143.117 | 13.000 | 799 | 799 | 0 | 130.917 | 143.917 | 13.000 | 3.657 | 3.657 |
| 2027-03 | 130.992 | 143.992 | 13.000 | 0 | 0 | 0 | 130.992 | 143.992 | 13.000 | 920 | 920 |
| 2027-04 | 124.601 | 136.888 | 12.287 | 0 | 0 | 0 | 124.601 | 136.888 | 12.287 | 920 | 920 |
| 2027-05 | 118.399 | 130.450 | 12.051 | 0 | 0 | 0 | 118.399 | 130.450 | 12.051 | 920 | 920 |
| 2027-06 | 116.972 | 117.554 | 582 | 0 | 0 | 0 | 116.972 | 117.554 | 582 | 920 | 920 |
| 2027-07 | 81.058 | 81.640 | 582 | 0 | 0 | 0 | 81.058 | 81.640 | 582 | 920 | 920 |
| 2027-08 | 48.727 | 49.309 | 582 | 0 | 0 | 0 | 48.727 | 49.309 | 582 | 920 | 920 |
| 2027-09 | 33.635 | 34.217 | 582 | 0 | 0 | 0 | 33.635 | 34.217 | 582 | 920 | 920 |
| 2027-10 | 32.378 | 32.960 | 582 | 0 | 0 | 0 | 32.378 | 32.960 | 582 | 0 | 0 |
| 2027-11 | 31.301 | 31.883 | 582 | 0 | 0 | 0 | 31.301 | 31.883 | 582 | 0 | 0 |
| 2027-12 | 30.673 | 31.255 | 582 | 0 | 0 | 0 | 30.673 | 31.255 | 582 | 0 | 0 |

#### SimpliRoute · Devengo (USD)

| Mes | Reconocido antes | después | dif. | Facturado antes | después | dif. | Diferido antes | después | dif. | Por facturar antes | después | dif. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-01 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-02 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2025-03 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.553 | 1.553 |
| 2025-04 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3.106 | 3.106 |
| 2025-05 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4.659 | 4.659 |
| 2025-06 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6.212 | 6.212 |
| 2025-07 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7.765 | 7.765 |
| 2025-08 | 0 | 1.553 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9.318 | 9.318 |
| 2025-09 | 1.232 | 2.785 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 1.232 | 12.103 | 10.871 |
| 2025-10 | 1.233 | 3.092 | 1.859 | 0 | 0 | 0 | 0 | 0 | 0 | 1.814 | 15.195 | 13.380 |
| 2025-11 | 11.833 | 13.692 | 1.859 | 0 | 0 | 0 | 0 | 0 | 0 | 13.647 | 28.886 | 15.239 |
| 2025-12 | 14.838 | 16.697 | 1.859 | 0 | 0 | 0 | 0 | 0 | 0 | 28.485 | 45.583 | 17.099 |
| 2026-01 | 23.329 | 25.275 | 1.946 | 0 | 0 | 0 | 0 | 0 | 0 | 51.001 | 71.079 | 20.077 |
| 2026-02 | 26.030 | 31.827 | 5.797 | 0 | 3.946 | 3.946 | 0 | 0 | 0 | 76.688 | 98.960 | 22.272 |
| 2026-03 | 32.329 | 35.384 | 3.055 | 1.924 | 5.945 | 4.021 | 0 | 0 | 0 | 107.093 | 128.399 | 21.306 |
| 2026-04 | 69.420 | 71.661 | 2.240 | 5.047 | 20.461 | 15.414 | 0 | 103 | 103 | 171.479 | 179.702 | 8.223 |
| 2026-05 | 208.573 | 212.167 | 3.595 | 26.374 | 97.248 | 70.874 | 110 | 407 | 298 | 353.937 | 294.820 | −59.117 |
| 2026-06 | 297.854 | 312.998 | 15.144 | 63.442 | 160.864 | 97.422 | 4.538 | 2.490 | −2.048 | 579.427 | 449.037 | −130.390 |
| 2026-07 | 436.270 | 454.485 | 18.215 | 128.216 | 340.125 | 211.909 | 23.891 | 13.888 | −10.003 | 859.902 | 574.795 | −285.107 |
| 2026-08 | 508.457 | 529.323 | 20.867 | 163.468 | 506.484 | 343.016 | 57.486 | 23.673 | −33.813 | 1.143.481 | 605.127 | −538.354 |
| 2026-09 | 532.970 | 547.914 | 14.944 | 205.518 | 323.306 | 117.788 | 302.495 | 25.670 | −276.825 | 1.017.428 | 831.732 | −185.696 |
| 2026-10 | 516.323 | 532.939 | 16.616 | 75.490 | 75.490 | 0 | 243.444 | 17.104 | −226.340 | 1.369.821 | 1.280.615 | −89.206 |
| 2026-11 | 506.800 | 523.416 | 16.616 | 0 | 0 | 0 | 165.047 | 11.973 | −153.074 | 1.795.724 | 1.798.900 | 3.177 |
| 2026-12 | 500.006 | 516.622 | 16.616 | 0 | 0 | 0 | 118.068 | 10.010 | −108.058 | 2.246.250 | 2.313.559 | 67.309 |
| 2027-01 | 125.559 | 138.311 | 12.752 | 0 | 0 | 0 | 120.149 | 15.564 | −104.584 | 2.366.672 | 2.457.425 | 90.753 |
| 2027-02 | 130.302 | 143.334 | 13.032 | 0 | 0 | 0 | 116.432 | 14.700 | −101.731 | 2.493.205 | 2.599.896 | 106.691 |
| 2027-03 | 131.177 | 144.209 | 13.032 | 0 | 0 | 0 | 115.202 | 13.837 | −101.366 | 2.623.100 | 2.743.241 | 120.141 |
| 2027-04 | 124.786 | 137.105 | 12.319 | 0 | 0 | 0 | 114.134 | 12.973 | −101.161 | 2.746.766 | 2.879.482 | 132.716 |
| 2027-05 | 117.765 | 129.848 | 12.083 | 0 | 0 | 0 | 113.887 | 12.928 | −100.960 | 2.864.233 | 3.009.285 | 145.053 |
| 2027-06 | 117.157 | 117.772 | 614 | 0 | 0 | 0 | 112.934 | 12.064 | −100.870 | 2.980.384 | 3.126.193 | 145.809 |
| 2027-07 | 81.243 | 81.857 | 614 | 0 | 0 | 0 | 112.090 | 11.297 | −100.793 | 3.060.783 | 3.207.284 | 146.500 |
| 2027-08 | 48.912 | 49.526 | 614 | 0 | 0 | 0 | 111.246 | 10.531 | −100.715 | 3.108.852 | 3.256.044 | 147.192 |
| 2027-09 | 33.852 | 34.434 | 582 | 0 | 0 | 0 | 110.906 | 10.191 | −100.715 | 3.142.363 | 3.290.137 | 147.774 |
| 2027-10 | 32.595 | 33.177 | 582 | 0 | 0 | 0 | 110.906 | 10.191 | −100.715 | 3.174.959 | 3.323.314 | 148.355 |
| 2027-11 | 31.517 | 32.100 | 584 | 0 | 0 | 0 | 110.906 | 10.191 | −100.715 | 3.206.476 | 3.355.414 | 148.939 |
| 2027-12 | 30.890 | 31.472 | 582 | 0 | 0 | 0 | 110.906 | 10.191 | −100.715 | 3.237.366 | 3.386.886 | 149.520 |

#### TiMining · MRR (USD)

| Mes | MRR antes | después | dif. | Pendiente de renovar antes | después |
|---|---:|---:|---:|---:|---:|
| 2025-01 | 138.162 | 138.162 | 0 | 0 | 0 |
| 2025-02 | 209.704 | 209.704 | 0 | 0 | 0 |
| 2025-03 | 218.345 | 218.345 | 0 | 0 | 0 |
| 2025-04 | 221.678 | 221.678 | 0 | 0 | 0 |
| 2025-05 | 254.011 | 254.011 | 0 | 0 | 0 |
| 2025-06 | 302.854 | 302.854 | 0 | 0 | 0 |
| 2025-07 | 302.479 | 302.479 | 0 | 0 | 0 |
| 2025-08 | 332.895 | 332.895 | 0 | 0 | 0 |
| 2025-09 | 341.812 | 341.812 | 0 | 24.000 | 24.000 |
| 2025-10 | 324.729 | 324.729 | 0 | 24.000 | 24.000 |
| 2025-11 | 322.229 | 322.229 | 0 | 24.000 | 24.000 |
| 2025-12 | 321.596 | 321.596 | 0 | 24.000 | 24.000 |
| 2026-01 | 329.550 | 329.550 | 0 | 24.000 | 24.000 |
| 2026-02 | 322.783 | 322.783 | 0 | 24.000 | 24.000 |
| 2026-03 | 322.758 | 322.758 | 0 | 25.875 | 25.875 |
| 2026-04 | 322.758 | 322.758 | 0 | 25.875 | 25.875 |
| 2026-05 | 324.367 | 324.367 | 0 | 29.042 | 29.042 |
| 2026-06 | 318.118 | 318.118 | 0 | 31.854 | 31.854 |
| 2026-07 | 306.951 | 306.951 | 0 | 43.021 | 43.021 |
| 2026-08 | 281.104 | 281.104 | 0 | 69.688 | 69.688 |
| 2026-09 | 351.729 | 351.729 | 0 | 95.688 | 95.688 |
| 2026-10 | 317.979 | 317.979 | 0 | 106.104 | 106.104 |
| 2026-11 | 317.562 | 317.562 | 0 | 106.104 | 106.104 |
| 2026-12 | 310.757 | 310.757 | 0 | 106.104 | 106.104 |
| 2027-01 | 267.883 | 269.014 | 1.130 | 106.104 | 106.104 |
| 2027-02 | 227.195 | 228.325 | 1.130 | 106.104 | 106.104 |
| 2027-03 | 193.580 | 194.710 | 1.130 | 79.229 | 79.229 |
| 2027-04 | 192.330 | 192.330 | 0 | 79.229 | 79.229 |
| 2027-05 | 186.376 | 186.376 | 0 | 76.062 | 76.062 |
| 2027-06 | 175.634 | 175.634 | 0 | 73.250 | 73.250 |
| 2027-07 | 147.856 | 147.856 | 0 | 71.583 | 71.583 |
| 2027-08 | 144.106 | 144.106 | 0 | 69.917 | 69.917 |
| 2027-09 | 112.023 | 112.023 | 0 | 44.917 | 44.917 |
| 2027-10 | 118.064 | 118.064 | 0 | 35.333 | 35.333 |
| 2027-11 | 118.064 | 118.064 | 0 | 10.333 | 10.333 |
| 2027-12 | 103.446 | 103.446 | 0 | 10.333 | 10.333 |

#### TiMining · Devengo (USD)

| Mes | Reconocido antes | después | dif. | Facturado antes | después | dif. | Diferido antes | después | dif. | Por facturar antes | después | dif. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-01 | 143.008 | 143.008 | 0 | 38.000 | 38.000 | 0 | 723.579 | 669.871 | −53.708 | 199.763 | 330.147 | 130.384 |
| 2025-02 | 210.550 | 210.550 | 0 | 181.527 | 181.527 | 0 | 805.046 | 732.974 | −72.072 | 310.253 | 422.273 | 112.020 |
| 2025-03 | 219.171 | 219.171 | 0 | 144.300 | 144.300 | 0 | 831.324 | 749.044 | −82.280 | 411.402 | 513.214 | 101.812 |
| 2025-04 | 222.524 | 222.524 | 0 | 380.786 | 380.786 | 0 | 961.760 | 882.105 | −79.655 | 383.576 | 488.013 | 104.437 |
| 2025-05 | 267.281 | 267.281 | 0 | 467.583 | 467.583 | 0 | 1.175.188 | 991.096 | −184.092 | 396.702 | 396.702 | 0 |
| 2025-06 | 308.655 | 308.967 | 312 | 558.975 | 558.975 | 0 | 1.404.191 | 951.481 | −452.710 | 67.774 | 84.579 | 16.805 |
| 2025-07 | 318.172 | 318.484 | 312 | 220.120 | 220.120 | 0 | 1.360.021 | 912.693 | −447.328 | 99.155 | 121.655 | 22.500 |
| 2025-08 | 330.364 | 330.676 | 312 | 805.300 | 805.300 | 0 | 1.645.181 | 1.175.040 | −470.141 | 156.879 | 156.879 | 0 |
| 2025-09 | 347.345 | 347.658 | 312 | 848.794 | 848.794 | 0 | 2.138.337 | 1.667.884 | −470.453 | 126.086 | 126.086 | 0 |
| 2025-10 | 330.262 | 330.574 | 312 | 47.433 | 47.433 | 0 | 2.056.031 | 1.463.583 | −592.447 | 177.844 | 182.427 | 4.583 |
| 2025-11 | 327.104 | 327.416 | 312 | 193.233 | 193.233 | 0 | 1.892.424 | 1.295.081 | −597.343 | 130.190 | 130.190 | 0 |
| 2025-12 | 326.535 | 326.848 | 312 | 148.820 | 148.820 | 0 | 1.770.020 | 1.204.780 | −565.240 | 157.917 | 190.332 | 32.415 |
| 2026-01 | 337.632 | 337.944 | 312 | 351.973 | 351.973 | 0 | 2.001.682 | 1.233.994 | −767.688 | 207.552 | 213.082 | 5.530 |
| 2026-02 | 328.196 | 328.508 | 312 | 542.047 | 542.047 | 0 | 2.240.529 | 1.473.998 | −766.530 | 194.100 | 201.100 | 7.000 |
| 2026-03 | 328.035 | 328.347 | 312 | 83.107 | 83.107 | 0 | 2.281.974 | 1.298.747 | −983.228 | 210.443 | 232.642 | 22.199 |
| 2026-04 | 326.992 | 327.304 | 312 | 411.573 | 411.573 | 0 | 2.687.059 | 1.313.918 | −1.373.141 | 0 | 125.098 | 125.098 |
| 2026-05 | 325.612 | 325.925 | 312 | 77.545 | 77.545 | 0 | 2.573.963 | 1.153.718 | −1.420.245 | 0 | 174.832 | 174.832 |
| 2026-06 | 324.085 | 324.085 | 0 | 463.921 | 463.921 | 0 | 2.777.840 | 967.658 | −1.810.182 | 0 | 136.515 | 136.515 |
| 2026-07 | 312.071 | 312.071 | 0 | 350.425 | 350.425 | 0 | 2.904.755 | 907.933 | −1.996.822 | 0 | 146.042 | 146.042 |
| 2026-08 | 297.921 | 297.921 | 0 | 1.095 | 1.095 | 0 | 2.834.570 | 715.540 | −2.119.030 | 18.333 | 198.750 | 180.417 |
| 2026-09 | 324.124 | 327.696 | 3.571 | 0 | 0 | 0 | 2.988.057 | 553.597 | −2.434.460 | 93.125 | 311.684 | 218.559 |
| 2026-10 | 322.874 | 326.446 | 3.571 | 0 | 0 | 0 | 2.844.817 | 439.637 | −2.405.180 | 189.940 | 471.350 | 281.410 |
| 2026-11 | 314.957 | 318.529 | 3.571 | 0 | 0 | 0 | 2.680.565 | 343.469 | −2.337.097 | 288.244 | 641.309 | 353.065 |
| 2026-12 | 308.152 | 311.723 | 3.571 | 0 | 0 | 0 | 2.525.909 | 256.895 | −2.269.013 | 389.337 | 814.057 | 424.720 |
| 2027-01 | 298.304 | 303.006 | 4.702 | 0 | 0 | 0 | 34.759.865 | 199.786 | −34.560.079 | 504.893 | 1.003.893 | 499.000 |
| 2027-02 | 257.615 | 262.317 | 4.702 | 0 | 0 | 0 | 34.688.028 | 156.699 | −34.531.329 | 639.363 | 1.170.684 | 531.321 |
| 2027-03 | 227.571 | 228.702 | 1.130 | 0 | 0 | 0 | 34.624.806 | 128.532 | −34.496.273 | 752.405 | 1.318.782 | 566.377 |
| 2027-04 | 226.321 | 226.321 | 0 | 0 | 0 | 0 | 34.567.056 | 103.799 | −34.463.257 | 869.669 | 1.469.062 | 599.393 |
| 2027-05 | 186.617 | 186.617 | 0 | 0 | 0 | 0 | 34.515.359 | 81.269 | −34.434.090 | 953.282 | 1.581.842 | 628.560 |
| 2027-06 | 175.634 | 175.634 | 0 | 0 | 0 | 0 | 34.471.313 | 69.306 | −34.402.007 | 1.033.562 | 1.694.205 | 660.643 |
| 2027-07 | 147.856 | 147.856 | 0 | 0 | 0 | 0 | 34.448.100 | 57.343 | −34.390.757 | 1.113.842 | 1.785.735 | 671.893 |
| 2027-08 | 144.106 | 144.106 | 0 | 0 | 0 | 0 | 34.428.637 | 45.380 | −34.383.257 | 1.194.122 | 1.873.515 | 679.393 |
| 2027-09 | 118.064 | 118.064 | 0 | 0 | 0 | 0 | 34.413.340 | 33.416 | −34.379.924 | 1.205.027 | 1.887.754 | 682.727 |
| 2027-10 | 118.064 | 118.064 | 0 | 0 | 0 | 0 | 34.398.044 | 21.453 | −34.376.590 | 1.215.932 | 1.901.992 | 686.060 |
| 2027-11 | 118.064 | 118.064 | 0 | 0 | 0 | 0 | 34.382.747 | 9.490 | −34.373.257 | 1.226.837 | 1.916.230 | 689.393 |
| 2027-12 | 103.446 | 103.446 | 0 | 0 | 0 | 0 | 34.379.414 | 9.490 | −34.369.924 | 1.235.087 | 1.927.814 | 692.727 |

#### uPlanner · MRR (USD)

| Mes | MRR antes | después | dif. | Pendiente de renovar antes | después |
|---|---:|---:|---:|---:|---:|
| 2025-01 | 193.317 | 193.317 | 0 | 0 | 0 |
| 2025-02 | 205.197 | 205.197 | 0 | 0 | 0 |
| 2025-03 | 210.147 | 210.147 | 0 | 0 | 0 |
| 2025-04 | 219.585 | 219.585 | 0 | 0 | 0 |
| 2025-05 | 219.585 | 219.585 | 0 | 0 | 0 |
| 2025-06 | 227.050 | 227.050 | 0 | 0 | 0 |
| 2025-07 | 251.576 | 251.576 | 0 | 0 | 0 |
| 2025-08 | 261.781 | 261.781 | 0 | 0 | 0 |
| 2025-09 | 286.468 | 286.468 | 0 | 0 | 0 |
| 2025-10 | 300.364 | 300.364 | 0 | 0 | 0 |
| 2025-11 | 300.364 | 300.364 | 0 | 0 | 0 |
| 2025-12 | 308.205 | 308.205 | 0 | 0 | 0 |
| 2026-01 | 317.449 | 317.449 | 0 | 0 | 0 |
| 2026-02 | 316.593 | 316.593 | 0 | 0 | 0 |
| 2026-03 | 316.904 | 316.904 | 0 | 0 | 0 |
| 2026-04 | 321.419 | 321.419 | 0 | 0 | 0 |
| 2026-05 | 321.419 | 321.419 | 0 | 0 | 0 |
| 2026-06 | 321.419 | 321.419 | 0 | 0 | 0 |
| 2026-07 | 290.211 | 290.211 | 0 | 17.036 | 17.036 |
| 2026-08 | 282.909 | 282.909 | 0 | 20.558 | 20.558 |
| 2026-09 | 241.441 | 241.441 | 0 | 65.493 | 65.493 |
| 2026-10 | 227.562 | 227.562 | 0 | 79.372 | 79.372 |
| 2026-11 | 219.228 | 219.228 | 0 | 79.372 | 79.372 |
| 2026-12 | 198.568 | 198.568 | 0 | 65.145 | 65.145 |
| 2027-01 | 117.538 | 117.538 | 0 | 55.766 | 55.766 |
| 2027-02 | 116.338 | 116.338 | 0 | 55.766 | 55.766 |
| 2027-03 | 115.415 | 115.415 | 0 | 55.766 | 55.766 |
| 2027-04 | 109.874 | 109.874 | 0 | 55.766 | 55.766 |
| 2027-05 | 105.556 | 105.556 | 0 | 55.766 | 55.766 |
| 2027-06 | 105.556 | 105.556 | 0 | 55.766 | 55.766 |
| 2027-07 | 105.556 | 105.556 | 0 | 38.730 | 38.730 |
| 2027-08 | 105.556 | 105.556 | 0 | 35.208 | 35.208 |
| 2027-09 | 99.410 | 99.410 | 0 | 16.667 | 16.667 |
| 2027-10 | 99.410 | 99.410 | 0 | 12.167 | 12.167 |
| 2027-11 | 93.608 | 93.608 | 0 | 12.167 | 12.167 |
| 2027-12 | 91.231 | 91.231 | 0 | 12.167 | 12.167 |

#### uPlanner · Devengo (USD)

| Mes | Reconocido antes | después | dif. | Facturado antes | después | dif. | Diferido antes | después | dif. | Por facturar antes | después | dif. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-01 | 194.317 | 195.817 | 1.500 | 690.029 | 690.029 | 0 | 846.265 | 846.265 | 0 | 210.650 | 218.150 | 7.500 |
| 2025-02 | 208.812 | 210.312 | 1.500 | 95.926 | 95.926 | 0 | 799.089 | 799.089 | 0 | 276.360 | 285.360 | 9.000 |
| 2025-03 | 210.522 | 212.022 | 1.500 | 128.428 | 128.428 | 0 | 729.993 | 729.993 | 0 | 289.359 | 299.859 | 10.500 |
| 2025-04 | 242.460 | 243.960 | 1.500 | 159.125 | 159.125 | 0 | 706.122 | 706.122 | 0 | 348.823 | 360.823 | 12.000 |
| 2025-05 | 219.960 | 221.460 | 1.500 | 363.023 | 363.023 | 0 | 819.562 | 819.562 | 0 | 319.199 | 332.699 | 13.500 |
| 2025-06 | 225.550 | 227.050 | 1.500 | 274.991 | 274.991 | 0 | 790.566 | 790.566 | 0 | 240.762 | 255.762 | 15.000 |
| 2025-07 | 257.160 | 258.660 | 1.500 | 190.363 | 190.363 | 0 | 896.108 | 896.108 | 0 | 242.738 | 259.238 | 16.500 |
| 2025-08 | 350.271 | 351.735 | 1.464 | 247.577 | 247.577 | 0 | 873.318 | 873.354 | 36 | 322.643 | 340.643 | 18.000 |
| 2025-09 | 292.088 | 293.552 | 1.464 | 505.602 | 505.602 | 0 | 1.184.829 | 1.184.902 | 72 | 346.891 | 366.391 | 19.500 |
| 2025-10 | 305.983 | 307.447 | 1.464 | 184.537 | 184.537 | 0 | 1.098.993 | 1.084.102 | −14.892 | 358.502 | 364.502 | 6.000 |
| 2025-11 | 305.983 | 307.447 | 1.464 | 335.421 | 335.421 | 0 | 1.097.107 | 1.083.752 | −13.355 | 327.178 | 336.178 | 9.000 |
| 2025-12 | 313.825 | 315.289 | 1.464 | 737.802 | 737.802 | 0 | 1.458.519 | 1.446.699 | −11.819 | 264.612 | 276.612 | 12.000 |
| 2026-01 | 322.213 | 323.677 | 1.464 | 227.236 | 227.236 | 0 | 1.419.166 | 1.408.883 | −10.283 | 338.324 | 353.324 | 15.000 |
| 2026-02 | 322.523 | 323.987 | 1.464 | 345.100 | 345.100 | 0 | 1.530.441 | 1.521.694 | −8.747 | 412.560 | 430.560 | 18.000 |
| 2026-03 | 325.835 | 327.299 | 1.464 | 493.385 | 493.385 | 0 | 1.689.171 | 1.622.020 | −67.151 | 301.341 | 332.331 | 30.990 |
| 2026-04 | 376.829 | 378.293 | 1.464 | 262.684 | 262.684 | 0 | 1.574.327 | 1.498.722 | −75.605 | 275.734 | 299.734 | 24.000 |
| 2026-05 | 326.682 | 328.146 | 1.464 | 186.986 | 186.986 | 0 | 1.539.233 | 1.397.515 | −141.718 | 342.327 | 369.327 | 27.000 |
| 2026-06 | 327.274 | 328.738 | 1.464 | 71.937 | 71.937 | 0 | 1.600.266 | 1.197.646 | −402.619 | 322.342 | 443.047 | 120.705 |
| 2026-07 | 319.050 | 320.514 | 1.464 | 151.896 | 151.896 | 0 | 1.850.575 | 1.081.133 | −769.442 | 376.596 | 510.100 | 133.505 |
| 2026-08 | 281.409 | 282.909 | 1.500 | 3.452 | 3.452 | 0 | 1.666.708 | 916.071 | −750.637 | 450.273 | 607.535 | 157.263 |
| 2026-09 | 249.041 | 249.041 | 0 | 0 | 0 | 0 | 1.513.917 | 782.491 | −731.426 | 529.563 | 706.036 | 176.473 |
| 2026-10 | 235.162 | 235.162 | 0 | 0 | 0 | 0 | 1.366.549 | 658.088 | −708.461 | 600.397 | 799.835 | 199.438 |
| 2026-11 | 219.228 | 219.228 | 0 | 0 | 0 | 0 | 1.234.199 | 547.820 | −686.379 | 670.316 | 891.836 | 221.520 |
| 2026-12 | 198.568 | 198.568 | 0 | 0 | 0 | 0 | 1.145.325 | 472.112 | −673.213 | 763.051 | 997.737 | 234.686 |
| 2027-01 | 117.538 | 117.538 | 0 | 0 | 0 | 0 | 362.184.820 | 12.257 | −362.172.563 | 636.574 | 850.085 | 213.510 |
| 2027-02 | 116.338 | 116.338 | 0 | 0 | 0 | 0 | 362.166.092 | 4.334 | −362.161.758 | 734.183 | 958.498 | 224.315 |
| 2027-03 | 115.415 | 115.415 | 0 | 0 | 0 | 0 | 362.151.391 | 438 | −362.150.953 | 834.898 | 1.070.018 | 235.120 |
| 2027-04 | 109.874 | 109.874 | 0 | 0 | 0 | 0 | 362.140.586 | 438 | −362.140.148 | 933.967 | 1.179.892 | 245.925 |
| 2027-05 | 105.556 | 105.556 | 0 | 0 | 0 | 0 | 362.129.781 | 438 | −362.129.343 | 1.028.717 | 1.285.448 | 256.730 |
| 2027-06 | 105.556 | 105.556 | 0 | 0 | 0 | 0 | 362.124.710 | 438 | −362.124.272 | 1.129.202 | 1.391.003 | 261.801 |
| 2027-07 | 105.556 | 105.556 | 0 | 0 | 0 | 0 | 362.119.863 | 438 | −362.119.425 | 1.229.911 | 1.496.559 | 266.649 |
| 2027-08 | 105.556 | 105.556 | 0 | 0 | 0 | 0 | 362.115.015 | 438 | −362.114.578 | 1.330.619 | 1.602.115 | 271.496 |
| 2027-09 | 99.410 | 99.410 | 0 | 0 | 0 | 0 | 362.110.168 | 438 | −362.109.731 | 1.425.182 | 1.701.525 | 276.343 |
| 2027-10 | 99.410 | 99.410 | 0 | 0 | 0 | 0 | 362.105.321 | 438 | −362.104.883 | 1.519.745 | 1.800.935 | 281.190 |
| 2027-11 | 93.608 | 93.608 | 0 | 0 | 0 | 0 | 362.100.474 | 438 | −362.100.036 | 1.608.506 | 1.894.543 | 286.037 |
| 2027-12 | 91.231 | 91.231 | 0 | 0 | 0 | 0 | 362.095.627 | 438 | −362.095.189 | 1.694.890 | 1.985.774 | 290.884 |

## 4. Top 20 contratos por diferencia, por holding

Orden por Σ|Δ MRR| + Σ|Δ reconocido| + Σ|Δ facturado| (2025-01 → 2027-12) + máx. |Δ diferido| + máx. |Δ por facturar|. TiMining tiene 21
contratos con diferencia y uPlanner 15 (se muestran todos hasta 20). Causas (banderas, puede haber varias):

- **En revisión sin devengo previo**: el contrato no tenía filas RSM y el rebuild las crea (D1).
- **Facturas no reflejadas**: en "antes" el facturado del mes no coincidía con las facturas emitidas de ese mes (RSM calculado antes de
  emitir; el rebuild las toma por `issue_date`).
- **Override revertido**: el devengo de un mes con `quantities` vuelve al plan (D2).
- **Prorrateo**: el primer mes se recalcula con `monthly_price` × días (S5-16, U5); antes, doble prorrateo o mes completo.
- **Acumulado U8**: en "antes" el acumulado devengado no era la suma del devengo (rebuild parcial que lo reiniciaba en 0) → diferido
  inflado y por facturar subestimado.
- **Tipo de cambio**: cambia la conversión al sistema (filas × 1,0 que pasan a NULL, o tasas cargadas después del último cálculo).

Conteo de causas sobre los contratos con diferencia:

| Holding | Con diferencia | En revisión | Facturas | Override | Prorrateo | Acumulado U8 | Tipo de cambio | Sin causa identificada |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SimpliRoute | 485 | 13 | 420 | 65 | 10 | 237 | 6 | 1 (CTR-2026-108, 2 USD) |
| TiMining | 21 | 0 | 0 | 0 | 5 | 20 | 2 | 0 |
| uPlanner | 15 | 0 | 4 | 0 | 3 | 13 | 12 | 0 |

Los "Máx. |Δ diferido|" de millones (EMI-01, uPlanner 188 y 235) son el efecto de las filas × 1,0 sin tasa descrito en §3; a sep-2026
su diferencia real es la columna "Δ diferido sep-26".


**SimpliRoute**

| # | Contrato | Estado | Σ\|Δ MRR\| | Σ\|Δ reconocido\| | Σ\|Δ facturado\| | Δ diferido sep-26 | Δ por facturar sep-26 | Máx. \|Δ diferido\| | Máx. \|Δ por facturar\| | Meses con cambio | Causa | Último cálculo antes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | CTR-2026-177 | En revisión | 118.485 | 118.485 | 0 | 0 | 39.495 | 0 | 118.485 | 19 | En revisión sin devengo previo | — |
| 2 | CTR-2026-05 | En revisión | 43.404 | 43.404 | 7.892 | 0 | 23.675 | 0 | 35.512 | 23 | En revisión sin devengo previo, facturas no reflejadas | — |
| 3 | CTR-2026-43 | Activo | 0 | 978 | 32.990 | 0 | −33.003 | 0 | 33.003 | 20 | facturas no reflejadas, override revertido | 2026-09-08 |
| 4 | CTR-2026-34 | En revisión | 18.636 | 18.636 | 0 | 0 | 18.636 | 0 | 18.636 | 34 | En revisión sin devengo previo | — |
| 5 | CTR-2026-94-CO | Activo | 0 | 2.420 | 14.013 | −13.783 | 10.866 | 13.783 | 24.649 | 18 | facturas no reflejadas, override revertido, acumulado U8 | 2026-09-28 |
| 6 | CTR-2026-51 | Activo | 0 | 2.781 | 25.993 | 0 | −23.212 | 0 | 23.212 | 20 | facturas no reflejadas, override revertido | 2026-09-23 |
| 7 | CTR-2026-202 | Activo | 0 | 0 | 25.307 | 0 | 25.307 | 0 | 25.307 | 17 | facturas no reflejadas, acumulado U8 | 2026-10-04 |
| 8 | CTR-2026-103 | Activo | 0 | 2.769 | 24.322 | 0 | −21.552 | 0 | 21.552 | 19 | facturas no reflejadas, override revertido | 2026-09-14 |
| 9 | CTR-2026-217 | En revisión | 14.256 | 14.256 | 0 | 0 | 4.752 | 0 | 14.256 | 19 | En revisión sin devengo previo | — |
| 10 | CTR-2026-07 | Activo | 0 | 163 | 18.455 | 0 | −18.618 | 0 | 18.618 | 20 | facturas no reflejadas, override revertido | 2026-09-29 |
| 11 | CTR-2026-61 | Activo | 0 | 4.985 | 14.003 | 0 | −17.458 | 0 | 17.458 | 20 | facturas no reflejadas, override revertido, prorrateo, acumulado U8 | 2026-09-08 |
| 12 | CTR-2026-224 | Activo | 0 | 5.400 | 15.487 | 0 | −10.087 | 0 | 11.304 | 19 | facturas no reflejadas, override revertido | 2026-09-14 |
| 13 | CTR-2026-47F05E | Activo | 0 | 0 | 12.366 | −9.906 | 0 | 9.906 | 9.906 | 17 | facturas no reflejadas, acumulado U8 | 2026-10-02 |
| 14 | CTR-2026-82 | Activo | 0 | 9.251 | 4.207 | 2.021 | −11.437 | 5.021 | 13.457 | 22 | facturas no reflejadas, override revertido | 2026-09-28 |
| 15 | S05610 | Activo | 0 | 0 | 14.758 | 0 | 0 | 0 | 14.758 | 4 | facturas no reflejadas | 2026-10-02 |
| 16 | CTR-2026-183 | En revisión | 8.559 | 8.559 | 0 | 0 | 4.280 | 0 | 8.559 | 21 | En revisión sin devengo previo | — |
| 17 | CTR-2026-142 | Activo | 0 | 7.647 | 6.168 | 2.470 | −5.177 | 2.470 | 7.647 | 20 | facturas no reflejadas, override revertido | 2026-09-30 |
| 18 | CTR-2026-110 | Activo | 0 | 432 | 11.050 | 0 | 11.536 | 0 | 11.536 | 18 | facturas no reflejadas, override revertido, acumulado U8 | 2026-09-07 |
| 19 | CTR-2026-200 | Activo | 0 | 2.220 | 0 | 0 | 16.536 | 3.966 | 16.536 | 19 | override revertido, acumulado U8 | 2026-09-15 |
| 20 | CTR-2026-73 | Activo | 0 | 162 | 10.580 | 0 | −10.562 | 0 | 10.562 | 18 | facturas no reflejadas, override revertido | 2026-09-08 |

**TiMining**

| # | Contrato | Estado | Σ\|Δ MRR\| | Σ\|Δ reconocido\| | Σ\|Δ facturado\| | Δ diferido sep-26 | Δ por facturar sep-26 | Máx. \|Δ diferido\| | Máx. \|Δ por facturar\| | Meses con cambio | Causa | Último cálculo antes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | EMI-01 | Activo | 3.391 | 3.391 | 0 | −34.101 | 0 | 32.395.875 | 0 | 20 | acumulado U8, tipo de cambio | 2026-08-26 |
| 2 | COD-04 | Activo | 0 | 0 | 0 | −362.500 | 187.500 | 404.167 | 375.000 | 21 | acumulado U8 | 2026-07-29 |
| 3 | COD-01 | Activo | 0 | 0 | 0 | −587.465 | 0 | 587.465 | 70.665 | 31 | prorrateo, acumulado U8 | 2026-10-04 |
| 4 | MRN-01 | Activo | 0 | 0 | 0 | −345.833 | 4.167 | 345.833 | 50.000 | 16 | acumulado U8 | 2026-08-26 |
| 5 | CEN-01 | Activo | 0 | 0 | 0 | −210.375 | 8.125 | 218.500 | 45.917 | 36 | acumulado U8 | 2026-10-04 |
| 6 | COL-01 | Activo | 0 | 0 | 0 | −125.292 | 0 | 125.292 | 125.292 | 36 | acumulado U8 | 2026-08-26 |
| 7 | PEL-01 | Activo | 0 | 3.750 | 0 | −108.187 | 0 | 108.187 | 104.437 | 36 | prorrateo, acumulado U8 | 2026-10-04 |
| 8 | SPE-01 | Activo | 0 | 0 | 0 | −169.500 | 0 | 169.500 | 0 | 18 | acumulado U8 | 2026-07-20 |
| 9 | CAN-01 | Activo | 0 | 0 | 0 | −95.817 | 3.350 | 99.167 | 15.850 | 17 | acumulado U8 | 2026-10-04 |
| 10 | CER-01 | Activo | 0 | 0 | 0 | −85.111 | 0 | 85.111 | 22.500 | 31 | acumulado U8 | 2026-08-26 |
| 11 | USI-01 | Activo | 0 | 0 | 0 | −37.500 | 7.500 | 41.250 | 45.000 | 17 | acumulado U8 | 2026-08-26 |
| 12 | BAM-01 | Activo | 0 | 0 | 0 | −68.333 | 0 | 68.333 | 0 | 22 | acumulado U8 | 2026-06-08 |
| 13 | SAL-01 | Activo | 0 | 0 | 0 | −62.424 | 0 | 62.424 | 0 | 20 | acumulado U8 | 2026-10-04 |
| 14 | SGO-01 | Activo | 0 | 0 | 0 | −60.258 | 0 | 60.258 | 0 | 19 | acumulado U8 | 2026-07-07 |
| 15 | AMS-01 | Activo | 0 | 0 | 0 | −51.371 | 0 | 51.371 | 0 | 19 | acumulado U8 | 2026-08-26 |
| 16 | ANG-02 | Activo | 0 | 0 | 0 | −13.750 | 0 | 43.750 | 7.500 | 24 | acumulado U8 | 2026-07-29 |
| 17 | LCO-01 | Activo | 0 | 21.429 | 0 | −1.488 | 2.083 | 1.488 | 21.429 | 16 | prorrateo | 2026-08-27 |
| 18 | MAS-01 | Activo | 0 | 0 | 0 | 0 | 5.833 | 5.833 | 5.833 | 18 | acumulado U8 | 2026-08-18 |
| 19 | AUR-01 | Activo | 0 | 0 | 0 | −5.000 | 0 | 5.000 | 3.750 | 21 | acumulado U8 | 2026-06-23 |
| 20 | SCO-01 | Activo | 0 | 0 | 0 | −7.500 | 0 | 7.500 | 0 | 19 | acumulado U8 | 2026-10-04 |

**uPlanner**

| # | Contrato | Estado | Σ\|Δ MRR\| | Σ\|Δ reconocido\| | Σ\|Δ facturado\| | Δ diferido sep-26 | Δ por facturar sep-26 | Máx. \|Δ diferido\| | Máx. \|Δ por facturar\| | Meses con cambio | Causa | Último cálculo antes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 188 | Activo | 0 | 0 | 0 | −67.649 | 0 | 258.239.520 | 0 | 20 | prorrateo, acumulado U8, tipo de cambio | 2026-08-17 |
| 2 | 235 | Activo | 0 | 0 | 0 | −27.144 | 0 | 103.617.090 | 0 | 19 | acumulado U8, tipo de cambio | 2026-08-17 |
| 3 | 237 | Activo | 0 | 0 | 0 | −18.717 | 108.200 | 48.117 | 126.917 | 19 | acumulado U8 | 2026-08-17 |
| 4 | 234 | Activo | 0 | 0 | 0 | −47.886 | 11.915 | 59.801 | 59.801 | 19 | acumulado U8 | 2026-08-17 |
| 5 | 165 | Cancelado | 0 | 0 | 0 | −100.790 | 0 | 100.790 | 0 | 6 | acumulado U8, tipo de cambio | 2026-08-17 |
| 6 | 197 | Activo | 0 | 0 | 0 | −85.000 | 10.000 | 90.000 | 10.000 | 19 | acumulado U8 | 2026-10-04 |
| 7 | 127 | Activo | 0 | 0 | 0 | −58.749 | 0 | 58.749 | 39.166 | 18 | acumulado U8 | 2026-08-17 |
| 8 | 199 | Activo | 0 | 30.000 | 0 | 0 | 36.000 | 15.000 | 36.000 | 36 | prorrateo | 2026-10-04 |
| 9 | 215 | Cancelado | 0 | 0 | 0 | −69.930 | 0 | 69.930 | 9.990 | 22 | acumulado U8 | 2026-08-17 |
| 10 | 135 | Activo | 0 | 0 | 0 | −67.597 | 0 | 67.597 | 11.266 | 6 | acumulado U8, tipo de cambio | 2026-08-17 |
| 11 | 232 | Activo | 0 | 0 | 0 | −51.786 | 10.357 | 55.238 | 20.714 | 7 | acumulado U8, tipo de cambio | 2026-08-17 |
| 12 | 243 | Activo | 0 | 0 | 0 | −54.112 | 0 | 54.112 | 0 | 18 | acumulado U8, tipo de cambio | 2026-08-17 |
| 13 | 193 | Cancelado | 0 | 0 | 0 | −54.000 | 0 | 54.000 | 0 | 18 | acumulado U8 | 2026-08-17 |
| 14 | 219 | Activo | 0 | 0 | 0 | −28.500 | 0 | 28.500 | 19.000 | 18 | acumulado U8 | 2026-08-17 |
| 15 | 126 | Activo | 0 | 434 | 0 | 434 | 0 | 434 | 0 | 29 | prorrateo | 2026-10-04 |

## 5. Chequeos pedidos

### 5.1 MRR legacy y corte U14 (solo SimpliRoute)

- **Sin doble conteo después**: 0 filas legacy contadas en un mes en que su contrato migrado ya tiene MRR (`09-check-legacy.sql`).
- Contratos destino de legacy (`migrated_to_contract_id`): 529. Antes 13 no tenían ningún mes con MRR (su legacy contaba entero hasta
  2026-12, 150.115 USD sumando meses); después 0. Transición legacy → contrato: continua 405 → 415, con solape cortado por U14 82 → 84,
  con hueco de más de un mes 29 → 30 (MRR que "desaparece" entre el fin del legacy y el inicio del contrato; dato, no del rebuild).
- Los 13 que cambian son los "En revisión" (D1): al crearles devengo, U14 corta su legacy desde el primer mes del contrato. Legacy con
  corte: −4.659 USD en 2026-05 y −3.946 USD/mes en 2026-06..08; el MRR de esos contratos lo reemplaza (y lo supera: +16.797 en 2026-06).
  Ejemplos: CTR-2026-05 (contrato desde 2026-02, legacy hasta 2026-08), CTR-2026-183 (2026-04 / 2026-05), CTR-2026-177 (2026-06 / 2026-05).

### 5.2 Prorrateo solo en el primer mes; nunca al final

Meses activos de cada ítem (en su moneda = la del contrato) donde el devengo ≠ mensual (`monthly_price`, o final ÷ plazo sin él):

| Holding | | Primer mes | De ellos, categoría que no prorratea (NEW/RENEWAL/sin categoría) | Meses intermedios | Último mes |
|---|---|---:|---:|---:|---:|
| SimpliRoute | antes | 45 | 36 | 164 (157 con override) | 4 |
| | después | 9 | 0 | 0 | 0 |
| TiMining | antes | 6 | 0 | 14 | 2 |
| | después | 4 | 0 | 0 | 0 |
| uPlanner | antes | 2 | 2 | 35 | 2 |
| | después | 0 | 0 | 3 (NC de descuento, permitido) | 0 |

Después del rebuild solo prorratean en el primer mes UPSELL / CROSS-SELL / DOWNSELL con inicio ≠ día de ciclo (13 ítems, p. ej.
S07276 UPSELL 05-08: 766,45 de 880 = 27/31; TiMining ANG-01 CROSS-SELL 11-08: 16.935,48 de 25.000), los demás meses van al mensual y
**ninguno prorratea al final**. Los 3 meses intermedios de uPlanner 188 (2026-05) son el ajuste de una NC de descuento clasificada
(`nc_discount_revenue_adjustment`). Consecuencia de la regla: un ajuste que empieza a mitad de ciclo y termina a mitad de ciclo no
reconoce el tramo final (D4, anexo C).

### 5.3 Pendientes de renovar (`apply_pending_renewal_tail`)

Sin cambios: SimpliRoute 56 filas / 8 ítems / 26.497 USD sumados, TiMining 223 / 18 / 1.603.583, uPlanner 312 / 24 / 871.012, iguales
antes y después. Todos los ítems elegibles (Activo, recurrente, vencido antes del mes en curso, sin renovación ni baja) tienen su cola
y ningún contrato Cancelado o En revisión la tiene. El rebuild la regenera en el mismo paso (01-10, D19).

### 5.4 Renovaciones con cambio de precio (`apply_renewal_price_split`)

TiMining 14 de 14 y uPlanner 11 de 11 renovaciones con cambio de precio quedan con la fila RENEWAL del primer mes al precio base y la
fila UPSELL/DOWNSELL con el delta, antes y después (base + delta = nuevo precio). SimpliRoute no tiene renovaciones con
`renewal_base_unit_price`. Ninguna cae en un mes cerrado.

### 5.5 Overrides que actualizan el devengo

**No se cumple** (D2). Ejemplo CTR-2026-61, ítem RENEWAL, plan 46.516.652 CLP/mes: overrides de 2026-05..08 (44.428.160, 48.182.708,
57.242.052, 50.021.160) facturados por esos montos; antes el devengo seguía el override, después vuelve a 46.516.652. Contratos
afectados (meses, |Δ reconocido| USD): CTR-2026-82 (6, 9.251), CTR-2026-142 (5, 7.647), CTR-2026-104 (4, 6.505), CTR-2026-224 (3, 5.400),
CTR-2026-61 (4, 4.671), CTR-2026-38 (1, 3.555), CTR-2026-Salvador (4, 3.106), CTR-2026-51 (4, 2.781), CTR-2026-103 (3, 2.769),
CTR-2026-94-CO (4, 2.420), CTR-2026-200 (3, 2.220) y 54 más con menos de 1.500 USD (lista completa: `07-check-overrides.sql`, tabla
`cmp.chk_ov`).

### 5.6 Fechas de las facturas que entran al RSM

El RSM toma cada línea de factura activa en estado Emitida / Enviada / Pagada / Vencida en el **mes de su `issue_date`** (las Por Emitir y
Canceladas no entran). Cotejo ítem × mes contra las facturas:

| Holding | Ítem-mes distintos antes | Contratos | Después | Contratos |
|---|---:|---:|---:|---:|
| SimpliRoute | 1.438 | 420 | 2 | 2 |
| TiMining | 0 | 0 | 0 | 0 |
| uPlanner | 8 | 4 | 8 | 4 |

Lo de antes es devengo calculado antes de emitir la factura y nunca recalculado (p. ej. CTR-2026-202: las facturas de agosto de 4 ítems
no estaban en agosto; el acumulado de septiembre sí las tenía). Lo que queda después son facturas emitidas **antes del primer mes del
contrato** (D3): SimpliRoute CTR-2026-02 (factura 2026-01, inicio 2026-08) y S06821 (2026-04 / 2026-05); uPlanner 194 (2025-06 / 2025-07),
200 (2025-09 / 2025-10), 218 (2025-04 / 2025-07), 221 (2025-08 / 2025-09).

### 5.7 Filas negativas y bajas como ítem negativo (no se corrigen ahora)

El rebuild recalcula estos ítems como cualquier otro; no cambian entre antes y después. Lista completa en el anexo B.

| Holding | Categoría | Ítems | Contratos | Diferido de esos ítems a sep-26 (USD) |
|---|---|---:|---:|---:|
| SimpliRoute | CHURN (baja como ítem negativo) | 58 | 54 (todos Cancelados) | 59.625 |
| SimpliRoute | DOWNSELL | 21 | 18 | 8.339 |
| TiMining | DOWNSELL | 3 | 2 | 109.166 |
| uPlanner | CHURN | 4 | 2 | 60.790 |
| uPlanner | DOWNSELL | 1 | 1 | 17.425 |

Se extienden más de lo debido:
- **DOWNSELL que pasan el fin de los ítems base**: SimpliRoute S04620 (ítem `526e2268`, −1,16 CLF/mes hasta 2027-09-24 con la base al
  2027-08-31) y S07608 (`2c03cd71`, −12.122,82 MXN/mes hasta 2027-01-28 con la base al 2027-01-26; no alcanza a sumar un mes negativo de más).
- **Contrato con MRR neto negativo** (baja y contracción restando lo mismo dos veces): CTR-2026-01 (DOWNSELL `cd632255` 2026-08..12 y
  CHURN `80165f82` 2026-10..12; 3 meses con neto −2 a −4 CLF) y S04172 (DOWNSELL `4910d30d` 2026-06..12 y CHURN `65360eb3` 2026-08..12;
  5 meses). Ambos Cancelados.
- En el resto, el MRR negativo de cada mes tiene MRR positivo del mismo producto que lo cubre; el problema es el diferido por ítem
  (la columna de la tabla), que el netting por contrato de Métricas compensa.

## 6. Contratos donde el rebuild falla o empeora algo

- **Falla (error de la función)**: ninguno (674/674). Sin avisos `RAISE WARNING` (split o FX).
- **Empeora**:
  - Los 65 contratos de SimpliRoute con overrides (§5.5, D2): el devengo deja de seguir lo facturado en esos meses.
  - Los 13 contratos En revisión (D1): CTR-2026-177, -05, -34, -217, -183, ctr-2026-218, -180, -219, -182, -181, -63, -178, -179 entran al
    MRR (y al reconocido) sin estar activados, y U14 les corta el legacy.
- **No empeora pero cambia la lectura**: filas sin tasa del sistema o de compañía (D5) que antes se sumaban × 1,0 ahora quedan NULL y fuera
  de los totales (contratos con alguna fila sin convertir al sistema: uPlanner 17, TiMining 12 → 12, SimpliRoute 6 → 5; ninguno nuevo).
  Las filas sin tasa de compañía bajan de 1.882 a 153 (SimpliRoute), 758 a 237 (TiMining) y 1.052 a 234 (uPlanner): el rebuild toma las
  tasas mensuales cargadas después del último cálculo.

## 7. Procedimiento para aplicarlo en producción (NO ejecutado)

Requisitos: OK de Domi a las diferencias de este documento (corrida final, §9) y a lo que queda por decidir en §9.5; primero en QA con el
mismo procedimiento; ventana sin uso del front actual y fuera de los jobs `contracts-extend-horizon` (05:45) y `refresh-pending-renewals`
(06:00). Un holding por vez, en este orden: **uPlanner → TiMining → SimpliRoute** (de menor a mayor impacto). `H` = id del holding;
`$PROD` = conexión de producción (`.env.prod.db`, sin imprimir).

**Procedimiento exacto de aplicación del bloque del 04-10** (assets + 4 migraciones + rebuild + cierre de mes). Se hace **completo en QA**
(`.env.qa.db`, `--target qa`), se verifica, y después igual en **producción** (`.env.prod.db`, `--target production`; todo comando que
escribe lleva además `--allow-production --confirm-target production`). Desde `api-sapira/`. Probado de punta a punta en la copia local
(`blk/run-full.sh`, §9.6).

**A · Preparación**
1. El bloque **commiteado** (el runner no aplica un asset con cambios sin commitear) y la API desplegada en el entorno con este código
   (`refreshInvoiceSystemAmounts` por estado, `monthly-average.ts`, `FxMonthCloseService`). Si Domi elige otro esquema de respaldo, se
   cambia `BACKUP_SCHEMA` en `src/databases/postgresql/backups.ts` **antes** de aplicar en cualquier entorno.
2. Estado (solo lectura):
   ```bash
   DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa
   DOTENV_CONFIG_PATH=.env.qa.db yarn migration:show --target qa
   ```
   `migration:show` debe listar como pendientes **exactamente** `1791200000000-InvoiceSystemAmountsFromInvoiceCurrency`,
   `1791300000000-RetiraTriggersDevengoQuantities`, `1791400000000-RetiraFuncionesSinUso` y `1791500000000-LimpiaPromediosMensualesManuales`
   (en producción, lectura del 04-10: la última aplicada es `CrmQuoteSnapshot1791100000000`, así que son esas 4). ⚠️ **`migration:run`
   corre TODAS las pendientes del árbol, en orden**: si aparece otra (de otro bloque, p. ej. Métricas), no correr hasta decidir con quien
   la escribió; no hay `--only` para migraciones. En QA, que nunca corrió todas, revisar la lista completa (GUIA §6).
3. Los assets de las funciones `rsm_rebuild_subscription`, `rsm_rebuild_from_subscription`, `rsm_apply_fx_for_subscription` y
   `get_effective_client_agent_config` **no cambian** (se quedan en la base y en el repo): no se aplican.

**B · Assets, uno por vez y en este orden** (excepción consciente a "migraciones antes que assets" de la GUIA: `1791200000000` exige el
asset nuevo del trigger y `1791300000000` el rebuild v3.7). Firmas sin cambio salvo la función nueva:
```bash
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --dry-run --target qa      # deben aparecer como NUEVO / REAPLICAR / PENDIENTE
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only functions/holding_fixed_fx_rate.sql --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only functions/revenue_schedule_apply_fx_for_contract.sql --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only functions/calculate_system_fx_rate.sql --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only functions/auto_populate_invoice_fx_to_system.sql --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only functions/revenue_schedule_rebuild_contract_ccy.sql --target qa
```
Verificación (solo lectura): `obj_description('public.revenue_schedule_rebuild_contract_ccy(uuid, date)'::regprocedure)` contiene
"v3.7 (04-10, Domi D3)" y `pg_get_functiondef('public.auto_populate_invoice_fx_to_system()'::regprocedure)` contiene
`IF NEW.status IS DISTINCT FROM 'Por Emitir'`. **Desde aquí hasta el paso C el trigger ya aplica la regla por estado** a toda factura
que se edite: correr C enseguida.

**C · Migraciones** (las 4, en una corrida; cada una en su transacción):
```bash
DOTENV_CONFIG_PATH=.env.qa.db yarn migration:show --target qa   # de nuevo: solo las 4
DOTENV_CONFIG_PATH=.env.qa.db yarn migration:run --target qa
```
Verificación (solo lectura, `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`); cifras de la copia del 04-10 entre paréntesis:
- `SELECT kind, count(*) FROM sapira_backups.invoice_system_fx_1791200000000 GROUP BY 1` (invoice 1.493, pending 6, credit_note 12 =
  1.511) y los KPIs de Facturación de SimpliRoute (§4.2 de `analisis-fx-y-mrr-historico.md`: por cobrar 1.822.731, vencido 1.412.400).
- `SELECT action, count(*) FROM sapira_backups.exchange_rates_monthly_avg_1791500000000 GROUP BY 1` (deleted 319, deleted_inverse 76, updated 212; borradas 395, firma md5
  `f491fa7fd2e695b3aba85d05ac45bd8b`, la misma que en producción el 04-10), `SELECT count(*) FROM exchange_rates_monthly_avg WHERE
  data_points = 1` (0) y filas sin ninguna tasa del par en `exchange_rates` en su mes (0).
- Triggers `trg_rsm_on_quantity_change` / `trg_restore_rsm_on_quantity_delete` ya no existen; las 62 funciones de `1791400000000` ya
  no existen y las 4 que se quedan sí (`rsm_rebuild_subscription`, `rsm_rebuild_from_subscription`, `rsm_apply_fx_for_subscription`,
  `get_effective_client_agent_config`).

**D · Rebuild del devengo por holding**: pasos 0 → 4 de abajo, **uPlanner → TiMining → SimpliRoute**, con el respaldo CSV del paso 1
antes de cada holding y lotes de 25 contratos (paso 2). El rebuild pone al día también la moneda de compañía de ene-2025 → sep-2026 con
los promedios recalculados. Los demás holdings (Hanka, Lenosoft) no se reconstruyen; el cierre del paso E les recalcula lo pendiente.

**E · Cierre de mes manual "hoy"**, después del rebuild (super admin; mismo proceso que el cron del día 1):
```bash
curl -X POST "$API_URL/banco-central/exchange-rates/close-month" -H "Authorization: Bearer <token super admin>" -H 'Content-Type: application/json' -d '{}'
```
Sin `month` cierra el mes que terminó (sep-2026: ya quedó cerrado por `1791500000000`, así que `closed_averages` vuelve vacío) y
recalcula los contratos con meses pendientes o tasa proyectada. En la copia: 0 promedios por cerrar, 24 contratos recalculados en 0,1 s,
1 fila de uPlanner sin moneda de compañía (MXN → CLP, sin fuente diaria) → aviso "Falta el tipo de cambio promedio de septiembre de 2026"
a uPlanner. Decidir antes si jul-2026 USD/PEN necesita `force` (con la regla nueva tiene 22 de 23 días: ya no).

**F · Cierre**:
```bash
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa      # al día: sin migraciones pendientes; los 5 assets APLICADO
# solo después de producción:
DOTENV_CONFIG_PATH=.env.prod.db yarn schema:snapshot --target production
git add <snapshots> && yarn vcp "Snapshot de producción tras el bloque FX/devengo del 04-10"
```
Los respaldos en `sapira_backups` se conservan hasta que Domi dé por buena la verificación; borrarlos es otra migración.

**Pasos 0–4 del rebuild (paso D de arriba), por holding:**

**0. Lista del lote** (solo lectura). **Todos** los contratos del holding sin borrar, en cualquier estado (decisión de Domi 04-10: el
rebuild procesa los datos como están; los En revisión / Borrador también entran y les crea devengo), con su `p_from_month`:

```sql
BEGIN TRANSACTION READ ONLY;
SELECT c.id, c.contract_number, c.status,
       CASE WHEN apc.cutoff_date IS NOT NULL THEN (date_trunc('month', apc.cutoff_date) + interval '1 month')::date END AS from_month
FROM contracts c
LEFT JOIN accounting_period_cutoff apc ON apc.company_id = c.company_id AND apc.holding_id = c.holding_id
WHERE c.holding_id = :'H' AND c.deleted_at IS NULL                     -- sin filtro por estado
ORDER BY c.contract_number;
ROLLBACK;
```

Releer `accounting_period_cutoff` el mismo día: si alguien cerró un período nuevo, cambia `from_month`. La lista de anomalías (§9.4)
**no es requisito**: se revisa después del rebuild; lo que Domi corrija como dato (activar o borrar un contrato, fechas, overrides) se
vuelve a reconstruir con este mismo procedimiento.

**1. Respaldo de la tabla** (fuera de la base, sin crear tablas en prod): exportar las filas de contratos del holding a un archivo cifrado
fuera del repo, y contar filas y sumas para verificar la restauración.

```bash
psql "$PROD" -X -c "\copy (SELECT * FROM revenue_schedule_monthly WHERE holding_id = '<H>' AND contract_id IS NOT NULL) TO 'rsm_<holding>_<fecha>.csv' CSV HEADER"
psql "$PROD" -X -c "BEGIN TRANSACTION READ ONLY; SELECT count(*), sum(mrr_period_contracted_system_ccy), sum(recognized_period_system_ccy), sum(billed_period_system_ccy) FROM revenue_schedule_monthly WHERE holding_id = '<H>' AND contract_id IS NOT NULL; ROLLBACK;"
```

(Si Leon prefiere una tabla de respaldo dentro de la base, va por migración según el checklist de cambios de esquema.)

**2. Rebuild en lotes** de 25 contratos, un lote por transacción; si un contrato falla, el lote entero vuelve atrás y se registra:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT revenue_schedule_rebuild(x.id, x.from_month)
FROM (VALUES ('<contrato 1>'::uuid, '<from_month o NULL>'::date), /* … 25 filas del paso 0 … */) AS x(id, from_month);
COMMIT;
```

En la copia el más lento tardó 0,4 s (promedio 6–37 ms), así que un holding entero son segundos; los lotes acotan bloqueos con el front
actual. No usar `revenue_schedule_rebuild_all`: recorre los contratos Activo de **todos** los holdings, siempre con rebuild completo (ignora el cierre por compañía) y sin respaldo por holding.

**3. Verificación posterior** (solo lectura, por holding), contra las cifras "después" de este documento (o las de una nueva corrida de
la copia si los datos cambiaron desde el 04-10):

- Filas de contratos del holding y sumas del paso 1 recalculadas; ninguna fila con `period_month` anterior a `from_month` modificada
  (`updated_at` de hoy en meses cerrados = 0).
- Facturas → RSM (chequeo D3 de `32-checks-final.sql` sobre prod): **0** ítem-mes con facturado distinto del `billed_period` (en la
  copia 0 en los tres holdings); los meses previos al inicio con facturado tienen devengo 0 y MRR 0.
- Overrides (`23-check-overrides-d2.sql`): todos los meses activos con override devengan el monto del override con la regla de la
  factura (en la copia 310 de 310).
- Tipo de cambio: filas con fuente `*_projected` solo en meses posteriores al mes en curso; filas `missing_fx_rate` del sistema = las
  de §9.3 (en la copia 0).
- Pendientes de renovar: mismas filas y montos que antes (§5.3). Split de renovaciones: todas OK (§5.4).
- Sin filas de suscripciones tocadas (`subscription_id IS NOT NULL` con `updated_at` de hoy = 0).
- Métricas e Ingresos con el holding: MRR, reconocido, diferido y por facturar iguales a la tabla §9.3 (±1 en moneda de sistema).

**4. Vuelta atrás** (solo si la verificación falla): en una transacción, borrar las filas de contratos del holding
(`DELETE FROM revenue_schedule_monthly WHERE holding_id = '<H>' AND contract_id IS NOT NULL`) y recargar el CSV con `\copy … FROM`.
Las filas traen `momentum` (el trigger `trg_assign_momentum` respeta un momentum no nulo); las de momentum NULL lo recalcularían: revisar
el conteo por momentum antes y después.

## 8. Reproducir

Carpeta de trabajo (local, fuera del repo; contiene datos de clientes, no se sube a ningún lado):
`/private/tmp/claude-501/-Users-domizamora-apps-nodeapps-sapira-front-sapira/a412d1ef-e856-4c88-a47b-ad7620484b02/scratchpad/pg-rebuild/`.

- `run-all.sh`: `pg_dump` de prod (solo lectura) → cluster Postgres 15 en `127.0.0.1:55432` → `00-stubs.sql` (roles `anon` /
  `authenticated` / `service_role`, `auth.uid()`, `auth.users` vacía, `pgcrypto` / `uuid-ossp` en `extensions`, `pg_trgm`, stubs de
  `net` y `vault`; la columna `vector` de la tabla RAG pasa a `text`) → restauración (errores esperados: 8 FK a `auth.users` y el índice
  `ivfflat`) → pasos `01`–`14`.
- `01-snapshot.sql` alcance y "antes" · `02-rebuild.sql` rebuild con registro de errores · `03-compare.sql` y `04-contracts.sql` totales
  por holding / contrato y mes · `05`–`13` chequeos (§5) · `14-tablas.sql` + `fmt.py` tablas de §3 · `show.sh <contrato>` filas antes/después
  de un contrato.
- Corrida 2 (§9): `run-d123.sh [base]` crea una base propia (`sapira_d2` por defecto) con `createdb -T sapira_pristine` (no toca
  `sapira_local` ni las bases de otras sesiones), aplica el asset `revenue_schedule_rebuild_contract_ccy.sql` del repo, corre
  `20-rebuild-d123.sql` (lote sin En revisión / Borrador), copia la corrida 1 (`sapira_local.cmp.rsm_after` → `cmp.rsm_run1`) y corre
  `21-compare-d123.sql` (diferencias fila a fila contra la corrida 1 y clasificación D1/D2/D3/resto), `22-check-facturas-d3.sql`,
  `23-check-overrides-d2.sql` y `24-monthly-d123.sql` (métricas por holding y mes en las tres versiones, misma regla que `03`).
  `run-d123.sh` es la corrida con D1–D3 (asset descartado); la vigente es `run-d2only.sh [base]` (`sapira_d2only` por defecto): mismos
  pasos con el asset v3.6 solo D2 y además copia la corrida D1–D3 (`sapira_d2.cmp.rsm_after` → `cmp.rsm_run2`) para compararla.
- **Bloque completo del 04-10 (§9.6, vigente): `blk/run-full.sh [base]`** (carpeta hermana `blk/` del scratchpad; `sapira_blk` por
  defecto, `createdb -T sapira_pristine`): los 5 assets del repo (`blk/assets.sh`), las 4 migraciones **del árbol** con el runner de
  TypeORM (`blk/mig.ts`, up/down), `30-rebuild-final.sql`, el cierre de mes real (`cia/run-close.ts`, `FxMonthCloseService` del árbol) y
  `31-monthly-final.sql`. `blk/inv.ts` mide la migración de facturas (KPIs de Facturación con `BillingReadService`, idempotencia y
  comparación con `refreshInvoiceSystemAmounts` en `sapira_blk2`); `blk/avg-cmp.sql`, el cambio de los promedios.
- Corrida final (§9): `run-final.sh [base]` (`sapira_final` por defecto, `createdb -T sapira_pristine`): aplica las 5
  funciones del árbol del repo (`holding_fixed_fx_rate`, `revenue_schedule_apply_fx_for_contract`, `calculate_system_fx_rate`,
  `auto_populate_invoice_fx_to_system`, `revenue_schedule_rebuild_contract_ccy` v3.7) y el SQL equivalente de las migraciones
  `1791200000000` y `1791300000000` (`mig-sql.py` lo arma leyendo los `.ts` del repo), y corre `30-rebuild-final.sql` (los 674 contratos,
  sin excluir), `31-monthly-final.sql` (producción hoy vs final por holding y mes, misma regla que Métricas; tabla a sep-2026),
  `32-checks-final.sql` (proyectadas solo hacia adelante, sin tasa, D3, anomalías de no activados) y, si existen `sapira_d2only` y
  `sapira_d2`, `33-vs-corridas.sql` (diferencias fila a fila contra la corrida 2 y la D1–D3). La tasa proyectada depende del día en que
  se corre (mes en curso del holding).

## 9. Corrida final · D2 + D3, sin excluir nada, con todas las funciones del árbol (04-10)

Base `sapira_final` (`run-final.sh`, §8), creada desde `sapira_pristine` (= producción del 04-10 09:40). Funciones aplicadas: las 5 del
árbol (`holding_fixed_fx_rate`, `revenue_schedule_apply_fx_for_contract`, `calculate_system_fx_rate`, `auto_populate_invoice_fx_to_system`,
`revenue_schedule_rebuild_contract_ccy` v3.7) + migraciones `1791200000000-FixMixedHeaderInvoiceSystemFx` (14 facturas F1; reemplazada el 04-10 por `InvoiceSystemAmountsFromInvoiceCurrency`, regla de moneda de factura) y
`1791300000000-RetiraTriggersDevengoQuantities` como SQL equivalente. Lote: **los 674 contratos** (598 Activo, 62 Cancelado, 14 En
revisión), mismos `p_from_month` que la corrida 1. **674 de 674 sin error**, 6,7 s (máx. 0,37 s). Suscripciones intactas (3.001 filas).
Corrida con fecha 04-10-2026: el mes en curso es oct-2026 y la tasa proyectada aplica desde nov-2026.

### 9.1 Qué cambió en la función (v3.7)

| # | Decisión de Domi | En `revenue_schedule_rebuild_contract_ccy` |
|---|---|---|
| D2 | El devengo respeta el override del mes, igual que la factura | Sin cambio respecto de v3.6 (§10.1): override del período = devengo del mes con la regla de la factura; MRR = plan |
| D3 | Facturas emitidas antes del inicio = datos históricos válidos | El rebuild arranca en el mes de la primera factura de un ítem del contrato cuando es anterior al inicio (espejo de FIX 1.2, que ya llegaba hasta la última factura después del fin). En esos meses el ítem no está activo: devengo 0, MRR 0; el monto queda como facturado (y diferido hasta que se devengue). Un rebuild parcial no cambia: arranca en `p_from_month` |
| D1 | Contratos En revisión / Borrador | **Sin guard por estado.** El rebuild procesa el contrato como está y le crea devengo; se revisan como anomalía (§9.4) |

Tasa proyectada (`holding_fixed_fx_rate`): **solo hacia adelante**. Aplica a meses posteriores al mes en curso del holding
(`holding_settings.timezone`, default America/Santiago); un mes pasado o el actual sin tasa queda "Sin tipo de cambio" (`missing_fx_rate`).
Detalle en [`analisis-fx-y-mrr-historico.md`](./analisis-fx-y-mrr-historico.md) Parte 4.

### 9.2 Verificación

| Chequeo | Resultado |
|---|---|
| Facturas → RSM (D3) | **0** ítem-mes con facturado ≠ `billed_period` en los tres holdings (corrida 2: 10). Los meses previos al inicio del ítem con facturado tienen devengo 0 y MRR 0 (SimpliRoute 2 filas, TiMining 16, uPlanner 14) |
| D3 vs corrida 2 | Cambian solo 6 contratos: SimpliRoute CTR-2026-02 (MXN, 7 filas 2026-01..07, 43.560 MXN facturados) y S06821 (1 fila 2026-04); uPlanner 194 (Cancelado), 200, 218 y 221 (15 filas 2025-04..09). Sin cambio de devengo ni de MRR |
| vs corrida D1–D3 (`sapira_d2`) | Idéntica fila a fila salvo los 13 En revisión (163 filas), que ahora tienen devengo |
| Overrides (D2) | Igual que la corrida 2: 310 de 310 meses activos con override devengan el override |
| Tipo de cambio | **0 filas `missing_fx_rate` del sistema** en los tres holdings (producción hoy: SimpliRoute 14, TiMining 17, uPlanner 334, todas de 2027+). Proyectadas: SimpliRoute 14 (2028-01..03), TiMining 11 (2027-01..11), uPlanner 334 (2027-01..2029-03); **0 en meses pasados o el actual**. Ningún mes hasta oct-2026 está sin tasa del sistema, así que la regla "solo hacia adelante" no cambia ninguna cifra de esta corrida |
| Facturas F1 | Las 14 facturas de la migración quedan con tasa CLP 930 (verificado) |

### 9.3 Por holding a sep-2026, en moneda de sistema

"Producción" = `sapira_pristine` (devengo de producción hoy). "Sin tasa" = filas con `fx_to_system_source` `missing_fx_rate` en todo el
devengo de contratos del holding (en sep-2026: 0 en las dos versiones). "Proyectadas" = filas con tasa proyectada (todas 2027+).

| Holding | MRR | Reconocido | Facturado | Diferido | Por facturar | Sin tasa | Proyectadas |
|---|---:|---:|---:|---:|---:|---:|---:|
| SimpliRoute · producción | 520.195 | 532.970 | 205.518 | 302.495 | 1.017.428 | 14 | 0 |
| **SimpliRoute · final** | **536.992** | **550.685** | **323.306** | **13.403** | **842.894** | **0** | **14** |
| TiMining · producción | 351.729 | 324.124 | 0 | 2.988.057 | 93.125 | 17 | 0 |
| **TiMining · final** | **351.729** | **327.696** | **0** | **553.597** | **311.684** | **0** | **11** |
| uPlanner · producción | 241.441 | 249.041 | 0 | 1.513.917 | 529.563 | 334 | 0 |
| **uPlanner · final** | **241.441** | **249.041** | **0** | **782.491** | **706.036** | **0** | **334** |

- **SimpliRoute**: MRR +16.797/mes y reconocido +17.715 frente a producción por los 13 En revisión que el rebuild procesa (sin ellos,
  = corrida 2: 520.195 / 533.888). Facturado 323.306 (facturas que el RSM de producción no reflejaba). Diferido 13.403. Por facturar
  842.894 (corrida 2: 744.792; la diferencia son los En revisión).
- **TiMining** y **uPlanner**: en sep-2026 igual a la corrida 2; D3 solo agrega meses de 2025–2026 anteriores al inicio. Desde 2027 suben
  por la tasa proyectada (antes esas filas quedaban sin convertir): uPlanner jun-2027 MRR 105.556 → 153.101; TiMining jun-2027
  175.634 → 179.258; el diferido de 2027 de producción (34,5 M TiMining, 362 M uPlanner, inflados por tasas 1,0 y filas sin tasa) baja a
  69.306 y 280.132.

### 9.4 Anomalías a revisar (Domi, después del rebuild; no son requisito)

| # | Caso | Qué quedó tras el rebuild | Qué revisar |
|---|---|---|---|
| D1 | **13 En revisión que el rebuild procesa** (SimpliRoute): CTR-2026-05, -34, -63, -177, -178, -179, -180, -181, -182, -183, -217, -219, ctr-2026-218 | 163 filas nuevas; MRR sep-2026 17.722 (con CTR-2026-176, que ya tenía 5 filas en producción y queda igual). CTR-2026-05 y -63 muestran sus facturas Vencidas (2026-02/03). U14 corta el legacy de los que son destino de MRR legacy | Activar los que corresponda; los que no, cancelar/borrar o dejar sin ítems, y volver a correr |
| D1-b | CTR-2026-004 (otro holding, `05583c6e…`, fuera de esta copia) | 12 filas 2026-10..2027-09 en producción | Igual que D1 |
| D3 | Facturas previas al inicio (ahora visibles, son datos válidos) | SimpliRoute CTR-2026-02 (factura 2026-01, inicio 2026-08) y S06821; uPlanner 194, 200, 218, 221 | Nada que corregir salvo que una fecha esté mal |
| D2-a | 3 meses con override distinto de lo facturado | CTR-2026-110 2026-07, CTR-2026-157 2026-06, CTR-2026-167-SSTT 2026-07 (§10.2) | Si el dato bueno es la factura, corregir el override |
| D4 | Ajustes con fin a mitad de ciclo / que pasan el fin de la base | Anexo C | Fechas |
| — | Ítems negativos del modelo anterior | Anexo B | Caso a caso |
| — | Filas sin tasa de compañía (`calc_version` `missing_fx_rate` con la del sistema convertida) | SimpliRoute 159, TiMining 428, uPlanner 470 (tasas de compañía no cargadas, sobre todo 2026-11+) | Cargar tasas de compañía y repetir el rebuild |

### 9.5 Queda por decidir

- **D2-c · Consumos v2** (`consumption_entries`): el rebuild no los lee (0 filas en prod; la regla del monto vive en el motor de precios
  TS). R8: que la API escriba el devengo del período al registrar el consumo, o que el rebuild tome el subtotal de las líneas del
  período de ítems medidos. Decidir antes de habilitar Pricing v2 a clientes.
- **Filas proyectadas que pasan a ser el mes en curso**: conservan la tasa proyectada hasta el siguiente recálculo (registrar la tasa
  del mes lo dispara; un rebuild o `apply_fx` también). Si se quiere que al cambiar de mes queden "Sin tipo de cambio" sin esperar, hace
  falta un recálculo programado al inicio de mes (no implementado).

### 9.6 Corrida del bloque completo (04-10, tarde): regla por estado, promedios corregidos, orden de aplicación de §7

Base `sapira_blk` (`blk/run-full.sh`, §8) desde `sapira_pristine`: 5 assets → migraciones `1791200000000` (regla por estado), `1791300000000`,
`1791400000000` (62 funciones; las 3 `rsm_*` y `get_effective_client_agent_config` se quedan) y `1791500000000` (promedios: borra
319 filas a mano + 76 inversas sin tasas propias, recalcula 212; idempotente y `down` exacto) con el runner
de TypeORM → rebuild de los 674 contratos (674 sin error, 7,3 s) → cierre de mes "hoy" (0 promedios por cerrar, 24 contratos
recalculados, 1 fila MXN → CLP de uPlanner sin moneda de compañía).

**Moneda de sistema a sep-2026: idéntica a §9.3, fila a fila** (20.501 filas de los tres holdings, 0 diferencias en MRR, reconocido,
facturado, acumulados y fuente de tasa): la regla por estado cambia `invoices` (Facturación), no el devengo, y los promedios solo
afectan la moneda de compañía (y la de sistema de Lenosoft, que no está en este lote).

| Holding | MRR | Reconocido | Facturado | Diferido | Por facturar |
|---|---:|---:|---:|---:|---:|
| SimpliRoute · producción → bloque | 520.195 → **536.992** | 532.970 → **550.685** | 205.518 → **323.306** | 302.495 → **13.403** | 1.017.428 → **842.894** |
| TiMining · producción → bloque | 351.729 → **351.729** | 324.124 → **327.696** | 0 → **0** | 2.988.057 → **553.597** | 93.125 → **311.684** |
| uPlanner · producción → bloque | 241.441 → **241.441** | 249.041 → **249.041** | 0 → **0** | 1.513.917 → **782.491** | 529.563 → **706.036** |

Efectos fuera de esta tabla: Facturación (§4.2 de `analisis-fx-y-mrr-historico.md`: SimpliRoute por cobrar 369,9 M → 1,82 M) y
Lenosoft (sistema CLP con promedio mensual): sin las proyecciones planas de CLF/CLP, nov-2026 → abr-2027 (6 filas, 858.711 CLP de MRR)
quedan "Sin tipo de cambio" en moneda de sistema (la tasa proyectada es solo de `fixed_period`; decisión pendiente).

## 10. Corrida 2 · solo D2 (04-10, superada por §9)

Misma copia de producción (base `sapira_d2only`, creada desde `sapira_pristine`), mismos `p_from_month` y mismas funciones que la
corrida 1 salvo `revenue_schedule_rebuild_contract_ccy` v3.6 **solo con D2** (asset del repo, aplicado solo en la copia). Lote:
**660 contratos** (674 − 14 En revisión: los contratos no activados quedan fuera del lote). 660 de 660 sin error, 6,3 s (máx. 0,39 s).
Suscripciones intactas (3.001 filas).

Una primera versión de v3.6 traía además D1 (guard por estado) y D3 (arranque en la primera factura); en esta corrida se habían
sacado. **Decisión definitiva (04-10, §9): D3 vuelve al código y D1 no; el lote no excluye nada.** La corrida con D1–D3
(`run-d123.sh`, base `sapira_d2`) queda solo como referencia: contra ella, esta corrida difiere únicamente en las 23 filas BOP de las
facturas previas al inicio (D3); todo lo demás es idéntico fila a fila.

### 10.1 Qué cambió en la función

| # | Decisión de Domi | Cambio en `revenue_schedule_rebuild_contract_ccy` |
|---|---|---|
| D2 | El devengo respeta el override del mes, igual que la factura | En cada mes **activo** del ítem, si hay `quantities` del período, el devengo del mes = la regla con que `sync_invoice_items_amounts_from_quantities` arma la línea: unitario × cantidad del override (el que falte, del ítem; solo monto → monto) × (1 − descuento % de la línea de factura del período, sin NC; sin línea, el % del ítem). Reemplaza el mensual del mes (con su prorrateo o pausa), como la factura. Sin override: el plan. **MRR sin cambio** (sigue siendo el plan, `mrr_period_contracted`) |
| D1 | Contrato no activado con devengo | **Sin cambio en código.** La función no mira `contracts.status`; los no activados se excluyen del lote (lote de esta corrida) |
| D3 | Facturas emitidas antes del inicio | **Sin cambio en código.** El inicio del rebuild sale solo de los ítems; las fechas mal cargadas se corregían como datos (revertido en §9) |

Consumos v2 (`consumption_entries`, Pricing v2) **no** se leen todavía: 0 filas en producción, y el monto del período sale del motor de
precios en TS (`priceLine`: tramos, mínimos, topes), que el SQL no replica. Ver §9.5.

### 10.2 Verificación pedida

| Chequeo | Resultado |
|---|---|
| Overrides siguen el override | **65 de 65** contratos de §5.5 y los 310 meses activos con override de los 78 contratos con `quantities` devengan el monto del override con la regla de la factura (idéntico a la corrida D1–D3). 307 de 310 coinciden además con lo facturado del período (antes 261, corrida 1 75); los 3 que no, en §9.5. 4 contratos más cambian (CTR-2026-130, -132, -138, -93-CL: overrides que difieren del plan en menos de 1 unidad). Los 5 overrides de meses fuera del ítem (anteriores al inicio, sin factura: CTR-2026-46, -106, -114, -126, -172) no se aplican |
| Resto sin cambios vs corrida 1 | **0 diferencias** en los otros 475 contratos de SimpliRoute (incluidos CTR-2026-02 y S06821), los 45 de TiMining y los 62 de uPlanner (comparación fila a fila de montos, acumulados, saldos y `calc_version`) |
| Facturas previas al inicio | Como en la corrida 1: 10 ítem-mes sin mes que muestre su facturado (SimpliRoute CTR-2026-02 y S06821; uPlanner 194, 200, 218, 221); el monto sí entra al acumulado. Resuelto en código en la corrida final (D3, §9) |
| En revisión | Fuera del lote: conservan lo que tienen en producción (13 sin filas; CTR-2026-176 con 5). Contra la corrida 1 (que los incluía y les creaba 163 filas) son las únicas otras diferencias: 14 contratos |
| MRR | Igual a "antes" en todos los meses de SimpliRoute y uPlanner (el +16.797 USD/mes de la corrida 1 era de los En revisión). TiMining igual a la corrida 1 |

Filas de contratos: SimpliRoute 7.557 antes → 7.806 corrida 1 → **7.643**; TiMining 4.617 → 4.683 → **4.683**; uPlanner 4.988 → 4.988 →
**4.988**. Contratos con alguna diferencia contra la corrida 1: SimpliRoute 83 (14 En revisión + 69 con overrides), TiMining 0, uPlanner 0.

### 10.3 Por holding, en una frase (a sep-2026, USD)

| Holding | MRR | Reconocido | Facturado | Diferido | Por facturar |
|---|---:|---:|---:|---:|---:|
| SimpliRoute · antes | 520.195 | 532.970 | 205.518 | 302.495 | 1.017.428 |
| SimpliRoute · corrida 1 | 536.992 | 547.914 | 323.306 | 25.670 | 831.732 |
| **SimpliRoute · corrida 2 (D2)** | **520.195** | **533.888** | **323.306** | **13.403** | **744.792** |
| TiMining · antes | 351.729 | 324.124 | 0 | 2.988.057 | 93.125 |
| **TiMining · corrida 1 = corrida 2** | **351.729** | **327.696** | **0** | **553.597** | **311.684** |
| uPlanner · antes | 241.441 | 249.041 | 0 | 1.513.917 | 529.563 |
| **uPlanner · corrida 1 = corrida 2** | **241.441** | **249.041** | **0** | **782.491** | **706.036** |

- **SimpliRoute**: MRR = antes (sin los En revisión). Reconocido 533.888: sin los En revisión y con los overrides de vuelta. Facturado
  = corrida 1. Diferido 13.403 y por facturar 744.792. Legacy con corte U14: igual a antes (sin los 13 En revisión, U14 no corta el
  legacy de 2026-05..08).
- **TiMining**: sin cambios contra la corrida 1.
- **uPlanner**: sin cambios contra la corrida 1 en ningún mes (las facturas previas al inicio siguen sin mes visible hasta la corrección
  de datos).

Efecto del override (D2) en el reconocido de SimpliRoute, solo los 78 contratos con `quantities` (USD): corrida 2 − corrida 1 = +23.973
netos (92.833 brutos) en 2026-01..12; corrida 2 − antes = +19.985 netos (23.207 brutos) en 60 ítem-mes: 52 son meses con override donde
el devengo de producción no seguía el override con la regla de la factura (sin override o sin el descuento de la línea) y 8 son el
prorrateo de la corrida 1.

### 10.4 Por holding y mes (solo meses con diferencia contra la corrida 1)

"c1" = corrida 1 (§3, columna "después"), "c2" = corrida 2 (D2). TiMining y uPlanner no tienen diferencias.

**SimpliRoute**

| Mes | MRR antes | c1 | c2 | Reconocido antes | c1 | c2 | Facturado antes | c1 | c2 | Diferido antes | c1 | c2 | Por facturar antes | c1 | c2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-03 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.553 | 0 |
| 2025-04 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3.106 | 0 |
| 2025-05 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4.659 | 0 |
| 2025-06 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6.212 | 0 |
| 2025-07 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7.765 | 0 |
| 2025-08 | 0 | 1.553 | 0 | 0 | 1.553 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9.318 | 0 |
| 2025-09 | 1.232 | 2.785 | 1.232 | 1.232 | 2.785 | 1.232 | 0 | 0 | 0 | 0 | 0 | 0 | 1.232 | 12.103 | 1.232 |
| 2025-10 | 1.233 | 3.092 | 1.233 | 1.233 | 3.092 | 1.233 | 0 | 0 | 0 | 0 | 0 | 0 | 1.814 | 15.195 | 2.465 |
| 2025-11 | 11.833 | 13.692 | 11.833 | 11.833 | 13.692 | 11.833 | 0 | 0 | 0 | 0 | 0 | 0 | 13.647 | 28.886 | 14.297 |
| 2025-12 | 14.838 | 16.697 | 14.838 | 14.838 | 16.697 | 14.838 | 0 | 0 | 0 | 0 | 0 | 0 | 28.485 | 45.583 | 29.135 |
| 2026-01 | 23.352 | 25.275 | 23.352 | 23.329 | 25.275 | 23.329 | 0 | 0 | 0 | 0 | 0 | 0 | 51.001 | 71.079 | 52.719 |
| 2026-02 | 25.958 | 31.827 | 25.958 | 26.030 | 31.827 | 26.030 | 0 | 3.946 | 0 | 0 | 0 | 0 | 76.688 | 98.960 | 78.749 |
| 2026-03 | 31.068 | 35.384 | 31.068 | 32.329 | 35.384 | 32.329 | 1.924 | 5.945 | 1.924 | 0 | 0 | 0 | 107.093 | 128.399 | 109.154 |
| 2026-04 | 66.632 | 71.661 | 66.632 | 69.420 | 71.661 | 69.459 | 5.047 | 20.461 | 20.461 | 0 | 103 | 103 | 171.479 | 179.702 | 158.256 |
| 2026-05 | 193.433 | 198.762 | 193.433 | 208.573 | 212.167 | 210.791 | 26.374 | 97.248 | 97.248 | 110 | 407 | 298 | 353.937 | 294.820 | 271.888 |
| 2026-06 | 294.610 | 311.407 | 294.610 | 297.854 | 312.998 | 303.783 | 63.442 | 160.864 | 160.864 | 4.538 | 2.490 | 1.660 | 579.427 | 449.037 | 416.169 |
| 2026-07 | 437.755 | 454.552 | 437.755 | 436.270 | 454.485 | 443.737 | 128.216 | 340.125 | 340.125 | 23.891 | 13.888 | 4.620 | 859.902 | 574.795 | 522.742 |
| 2026-08 | 512.090 | 528.888 | 512.090 | 508.457 | 529.323 | 511.462 | 163.468 | 506.484 | 506.484 | 57.486 | 23.673 | 9.197 | 1.143.481 | 605.127 | 530.005 |
| 2026-09 | 520.195 | 536.992 | 520.195 | 532.970 | 547.914 | 533.888 | 205.518 | 323.306 | 323.306 | 302.495 | 25.670 | 13.403 | 1.017.428 | 831.732 | 744.792 |
| 2026-10 | 516.437 | 532.939 | 516.437 | 516.323 | 532.939 | 516.637 | 75.490 | 75.490 | 75.490 | 243.444 | 17.104 | 11.396 | 1.369.821 | 1.280.615 | 1.183.931 |
| 2026-11 | 506.913 | 523.416 | 506.913 | 506.800 | 523.416 | 507.113 | 0 | 0 | 0 | 165.047 | 11.973 | 10.305 | 1.795.724 | 1.798.900 | 1.689.954 |
| 2026-12 | 500.119 | 516.622 | 500.119 | 500.006 | 516.622 | 500.264 | 0 | 0 | 0 | 118.068 | 10.010 | 9.387 | 2.246.250 | 2.313.559 | 2.189.300 |
| 2027-01 | 131.639 | 144.640 | 131.640 | 125.559 | 138.311 | 125.311 | 0 | 0 | 0 | 120.149 | 15.564 | 14.942 | 2.366.672 | 2.457.425 | 2.320.166 |
| 2027-02 | 130.117 | 143.117 | 130.118 | 130.302 | 143.334 | 130.335 | 0 | 0 | 0 | 116.432 | 14.700 | 14.078 | 2.493.205 | 2.599.896 | 2.449.637 |
| 2027-03 | 130.992 | 143.992 | 130.992 | 131.177 | 144.209 | 131.209 | 0 | 0 | 0 | 115.202 | 13.837 | 13.214 | 2.623.100 | 2.743.241 | 2.579.983 |
| 2027-04 | 124.601 | 136.888 | 124.602 | 124.786 | 137.105 | 124.819 | 0 | 0 | 0 | 114.134 | 12.973 | 12.351 | 2.746.766 | 2.879.482 | 2.703.938 |
| 2027-05 | 118.399 | 130.450 | 118.399 | 117.765 | 129.848 | 117.798 | 0 | 0 | 0 | 113.887 | 12.928 | 12.305 | 2.864.233 | 3.009.285 | 2.821.690 |
| 2027-06 | 116.972 | 117.554 | 116.973 | 117.157 | 117.772 | 117.190 | 0 | 0 | 0 | 112.934 | 12.064 | 11.442 | 2.980.384 | 3.126.193 | 2.938.016 |
| 2027-07 | 81.058 | 81.640 | 81.058 | 81.243 | 81.857 | 81.275 | 0 | 0 | 0 | 112.090 | 11.297 | 10.675 | 3.060.783 | 3.207.284 | 3.018.525 |
| 2027-08 | 48.727 | 49.309 | 48.728 | 48.912 | 49.526 | 48.945 | 0 | 0 | 0 | 111.246 | 10.531 | 9.909 | 3.108.852 | 3.256.044 | 3.066.704 |
| 2027-09 | 33.635 | 34.217 | 33.635 | 33.852 | 34.434 | 33.852 | 0 | 0 | 0 | 110.906 | 10.191 | 9.568 | 3.142.363 | 3.290.137 | 3.100.216 |
| 2027-10 | 32.378 | 32.960 | 32.378 | 32.595 | 33.177 | 32.595 | 0 | 0 | 0 | 110.906 | 10.191 | 9.568 | 3.174.959 | 3.323.314 | 3.132.811 |
| 2027-11 | 31.301 | 31.883 | 31.302 | 31.517 | 32.100 | 31.519 | 0 | 0 | 0 | 110.906 | 10.191 | 9.568 | 3.206.476 | 3.355.414 | 3.164.330 |
| 2027-12 | 30.673 | 31.255 | 30.673 | 30.890 | 31.472 | 30.890 | 0 | 0 | 0 | 110.906 | 10.191 | 9.568 | 3.237.366 | 3.386.886 | 3.195.220 |

(Diferencias de 1 USD en el MRR de 2027 entre antes y c2: redondeo. 2026-02 y 2026-03: el facturado de c1 incluía las facturas
Vencidas de CTR-2026-05 y -63, En revisión, que c2 no muestra.)

### 10.5 Corrección de datos

Reemplazada por la lista de anomalías a revisar de §9.4 (no es requisito del rebuild). D3 pasó a código (v3.7) y D1 se procesa como
está (sin excluir del lote).

## Anexo B · Ítems negativos (bajas y contracciones del modelo anterior)

Para la corrección de datos, caso a caso. "Ítem" = primeros 8 caracteres del id de `contract_items`. El diferido del ítem es el saldo por ítem que infla el diferido (Métricas lo netea por contrato).


| Holding | Contrato | Estado | Categoría | Ítem | Inicio | Fin | Meses con MRR negativo | N.º | Mensual (moneda contrato) | MRR mes (USD) | Diferido del ítem a sep-26 (USD) | Pasa el fin de los ítems base |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|
| SimpliRoute | CTR-2026-01 | Cancelado | CHURN | `80165f82` | 2026-10-01 | 2026-12-31 | 2026-10..2026-12 | 3 | -3,63 CLF | −156 | 0 | no |
| SimpliRoute | CTR-2026-127 | Cancelado | CHURN | `06242c4a` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -28,00 CLF | −1.204 | 3.612 | no |
| SimpliRoute | CTR-2026-132 | Cancelado | CHURN | `dbb72f9d` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -202,20 USD | −202 | 404 | no |
| SimpliRoute | CTR-2026-147 | Cancelado | CHURN | `9fcddbe3` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -20,00 CLF | −860 | 1.720 | no |
| SimpliRoute | CTR-2026-157 | Cancelado | CHURN | `ddcde2ee` | 2026-06-01 | 2026-12-31 | 2026-06..2026-12 | 7 | -15,30 CLF | −658 | 2.632 | no |
| SimpliRoute | CTR-2026-174 | Cancelado | CHURN | `209273f2` | 2026-09-01 | 2027-02-28 | 2026-09..2027-02 | 6 | -304,33 PEN | −90 | 90 | no |
| SimpliRoute | CTR-2026-214 | Cancelado | CHURN | `806726dc` | 2026-09-01 | 2027-04-30 | 2026-09..2027-04 | 8 | -4554,00 MXN | −240 | 240 | no |
| SimpliRoute | CTR-2026-214 | Cancelado | CHURN | `d737ce85` | 2026-09-01 | 2027-04-30 | 2026-09..2027-04 | 8 | -41400,00 MXN | −2.179 | 2.179 | no |
| SimpliRoute | CTR-2026-214 | Cancelado | CHURN | `867138c3` | 2026-09-01 | 2027-04-30 | 2026-09..2027-04 | 8 | -13376,00 MXN | −704 | 704 | no |
| SimpliRoute | CTR-2026-58 | Cancelado | CHURN | `08fe8ec1` | 2026-08-01 | 2027-01-02 | 2026-08..2026-12 | 5 | -1749,00 PEN | −514 | 1.029 | no |
| SimpliRoute | CTR-2026-66 | Cancelado | CHURN | `fa0fb2d0` | 2025-10-01 | 2026-09-30 | 2025-10..2026-09 | 12 | -1337,99 PEN | −394 | 4.722 | no |
| SimpliRoute | S01664 | Cancelado | CHURN | `fff1e2c6` | 2026-07-01 | 2027-01-20 | 2026-07..2026-12 | 6 | -1,10 CLF | −47 | 142 | no |
| SimpliRoute | S01740 | Cancelado | CHURN | `b2e7423d` | 2026-06-25 | 2027-01-24 | 2026-06..2026-12 | 7 | -2,20 CLF | −95 | 378 | no |
| SimpliRoute | S02359 | Cancelado | CHURN | `f8b5c91a` | 2026-07-01 | 2027-01-27 | 2026-07..2026-12 | 6 | -7,68 CLF | −330 | 991 | no |
| SimpliRoute | S02360 | Cancelado | CHURN | `83da1b23` | 2026-07-01 | 2027-01-27 | 2026-07..2026-12 | 6 | -50,00 USD | −50 | 150 | no |
| SimpliRoute | S02497 | Cancelado | CHURN | `51d2da7b` | 2026-07-01 | 2027-05-13 | 2026-07..2027-04 | 10 | -10,64 CLF | −458 | 1.373 | no |
| SimpliRoute | S02497 | Cancelado | CHURN | `7fe85c6d` | 2026-07-01 | 2027-05-13 | 2026-07..2027-04 | 10 | -8,40 CLF | −361 | 1.084 | no |
| SimpliRoute | S02636 | Cancelado | CHURN | `2f6ead9b` | 2026-10-01 | 2027-01-04 | 2026-10..2026-12 | 3 | -2,64 CLF | −114 | 0 | no |
| SimpliRoute | S02645 | Cancelado | CHURN | `a1a80136` | 2026-07-01 | 2027-01-12 | 2026-07..2026-12 | 6 | -7,25 CLF | −312 | 935 | no |
| SimpliRoute | S02668 | Cancelado | CHURN | `443256cd` | 2026-06-28 | 2027-01-27 | 2026-06..2026-12 | 7 | -1,45 CLF | −62 | 249 | no |
| SimpliRoute | S02773 | Cancelado | CHURN | `796bd498` | 2026-07-01 | 2027-01-27 | 2026-07..2026-12 | 6 | -21,78 CLF | −937 | 2.810 | no |
| SimpliRoute | S02838 | Cancelado | CHURN | `89b917de` | 2026-08-01 | 2027-01-27 | 2026-08..2026-12 | 5 | -1,21 CLF | −52 | 104 | no |
| SimpliRoute | S04148 | Cancelado | CHURN | `99056b84` | 2026-05-01 | 2027-01-10 | 2026-05..2026-12 | 8 | -1,32 CLF | −57 | 284 | no |
| SimpliRoute | S04172 | Cancelado | CHURN | `65360eb3` | 2026-08-01 | 2027-01-27 | 2026-08..2026-12 | 5 | -4,85 CLF | −209 | 417 | no |
| SimpliRoute | S04565 | Cancelado | CHURN | `a6ece4da` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -7,25 CLF | −312 | 624 | no |
| SimpliRoute | S04587 | Cancelado | CHURN | `49862bc3` | 2026-09-01 | 2026-12-31 | 2026-09..2026-12 | 4 | -6,60 CLF | −284 | 284 | no |
| SimpliRoute | S04745 | Cancelado | CHURN | `d98f20f6` | 2026-07-01 | 2027-01-04 | 2026-07..2026-12 | 6 | -2,20 CLF | −95 | 284 | no |
| SimpliRoute | S04745 | Cancelado | CHURN | `1dd0dc74` | 2026-07-01 | 2027-01-04 | 2026-07..2026-12 | 6 | -3,00 CLF | −129 | 387 | no |
| SimpliRoute | S04810 | Cancelado | CHURN | `9fe5bfba` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -7,13 CLF | −307 | 613 | no |
| SimpliRoute | S05614 | Cancelado | CHURN | `f20b0c84` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -360,00 USD | −360 | 1.080 | no |
| SimpliRoute | S06297 | Cancelado | CHURN | `fcb5dbef` | 2026-06-01 | 2026-12-31 | 2026-06..2026-12 | 7 | -3,20 CLF | −138 | 550 | no |
| SimpliRoute | S06298 | Cancelado | CHURN | `985773cb` | 2026-05-01 | 2026-12-31 | 2026-05..2026-12 | 8 | -3,20 CLF | −138 | 688 | no |
| SimpliRoute | S06460 | Cancelado | CHURN | `6ab8bfdc` | 2026-05-01 | 2026-12-31 | 2026-05..2026-12 | 8 | -6,24 CLF | −268 | 1.342 | no |
| SimpliRoute | S06859 | Cancelado | CHURN | `02d506aa` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -143,88 USD | −144 | 432 | no |
| SimpliRoute | S06862 | Cancelado | CHURN | `72da2a33` | 2026-10-01 | 2026-12-31 | 2026-10..2026-12 | 3 | -588,25 USD | −588 | 0 | no |
| SimpliRoute | S06868 | Cancelado | CHURN | `fd30c8a6` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -264,00 USD | −264 | 528 | no |
| SimpliRoute | S06897 | Cancelado | CHURN | `bfb356cf` | 2026-06-01 | 2027-01-24 | 2026-06..2026-12 | 7 | -2462610,69 COP | −640 | 2.559 | no |
| SimpliRoute | S06907 | Cancelado | CHURN | `010df8fb` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -1159356,00 COP | −301 | 602 | no |
| SimpliRoute | S06952 | Cancelado | CHURN | `f96c47da` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -21,58 CLF | −928 | 2.784 | no |
| SimpliRoute | S06953 | Cancelado | CHURN | `bb0f1ff7` | 2026-06-08 | 2027-01-07 | 2026-06..2026-12 | 7 | -13,08 CLF | −562 | 2.250 | no |
| SimpliRoute | S06957 | Cancelado | CHURN | `7f81f29a` | 2026-08-01 | 2027-01-01 | 2026-08..2026-12 | 5 | -459,80 USD | −460 | 920 | no |
| SimpliRoute | S06974 | Cancelado | CHURN | `9df5c2be` | 2026-08-01 | 2027-07-31 | 2026-08..2027-07 | 12 | -619977,51 COP | −161 | 322 | no |
| SimpliRoute | S07053 | Cancelado | CHURN | `47ea9e40` | 2026-10-01 | 2027-01-09 | 2026-10..2026-12 | 3 | -1839,20 MXN | −97 | 0 | no |
| SimpliRoute | S07078 | Cancelado | CHURN | `1c28c2a2` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -10450000,00 COP | −2.714 | 8.143 | no |
| SimpliRoute | S07086 | Cancelado | CHURN | `2a564e4c` | 2026-08-01 | 2027-01-14 | 2026-08..2026-12 | 5 | -3,63 CLF | −156 | 312 | no |
| SimpliRoute | S07088 | Cancelado | CHURN | `5e243960` | 2026-08-01 | 2027-01-16 | 2026-08..2026-12 | 5 | -6,60 CLF | −284 | 568 | no |
| SimpliRoute | S07137 | Cancelado | CHURN | `36a8d11a` | 2026-09-01 | 2027-01-26 | 2026-09..2026-12 | 4 | -4840,00 MXN | −255 | 255 | no |
| SimpliRoute | S07138 | Cancelado | CHURN | `57f349e5` | 2026-09-01 | 2027-01-26 | 2026-09..2026-12 | 4 | -1742,40 MXN | −92 | 92 | no |
| SimpliRoute | S07143 | Cancelado | CHURN | `0aafed21` | 2026-08-01 | 2027-01-16 | 2026-08..2026-12 | 5 | -6195,20 MXN | −326 | 652 | no |
| SimpliRoute | S07195 | Cancelado | CHURN | `85028049` | 2026-06-01 | 2026-12-31 | 2026-06..2026-12 | 7 | -9,00 CLF | −387 | 1.548 | no |
| SimpliRoute | S07318 | Cancelado | CHURN | `8e046593` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -619977,00 COP | −161 | 483 | no |
| SimpliRoute | S07350 | Cancelado | CHURN | `411cb760` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -1432146,87 COP | −372 | 744 | no |
| SimpliRoute | S07669 | Cancelado | CHURN | `a7a5a9b3` | 2026-09-01 | 2027-01-11 | 2026-09..2026-12 | 4 | -7744,00 MXN | −408 | 408 | no |
| SimpliRoute | S07737 | Cancelado | CHURN | `9488521b` | 2026-08-01 | 2027-01-24 | 2026-08..2026-12 | 5 | -1,45 CLF | −62 | 125 | no |
| SimpliRoute | S07796 | Cancelado | CHURN | `1d633012` | 2026-09-01 | 2027-01-29 | 2026-09..2026-12 | 4 | -19360,00 MXN | −1.019 | 1.019 | no |
| SimpliRoute | S07810 | Cancelado | CHURN | `8fa86352` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -1636739,28 COP | −425 | 1.275 | no |
| SimpliRoute | S07970 | Cancelado | CHURN | `78bf593f` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -2893226,00 COP | −751 | 1.503 | no |
| SimpliRoute | S08473 | Cancelado | CHURN | `e019eed6` | 2026-10-01 | 2026-12-31 | 2026-10..2026-12 | 3 | -9500,00 MXN | −500 | 0 | no |
| SimpliRoute | CTR-2026-01 | Cancelado | DOWNSELL | `cd632255` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -2,42 CLF | −104 | 208 | no |
| SimpliRoute | CTR-2026-212 | Activo | DOWNSELL | `aeef9e07` | 2026-09-01 | 2027-04-30 | 2026-09..2027-04 | 8 | -1408,00 MXN | −74 | 74 | no |
| SimpliRoute | CTR-2026-F403CD | Activo | DOWNSELL | `a6e54401` | 2026-07-06 | 2027-07-05 | 2026-07..2027-06 | 12 | -0,74 CLF | −32 | 95 | no |
| SimpliRoute | S01688 | Activo | DOWNSELL | `e6bf43ed` | 2026-07-25 | 2027-01-24 | 2026-07..2026-12 | 6 | -1,00 CLF | −43 | 129 | no |
| SimpliRoute | S02656 | Activo | DOWNSELL | `120193e7` | 2026-08-28 | 2027-01-27 | 2026-08..2026-12 | 5 | -1,45 CLF | −62 | 125 | no |
| SimpliRoute | S02656 | Activo | DOWNSELL | `998c415f` | 2026-08-28 | 2027-01-27 | 2026-08..2026-12 | 5 | -1,45 CLF | −62 | 125 | no |
| SimpliRoute | S02660 | Activo | DOWNSELL | `9a953987` | 2026-08-28 | 2027-01-27 | 2026-08..2026-12 | 5 | -2,90 CLF | −125 | 249 | no |
| SimpliRoute | S02823 | Activo | DOWNSELL | `327f2e71` | 2026-08-28 | 2027-01-27 | 2026-08..2026-12 | 5 | -1,21 CLF | −52 | 104 | no |
| SimpliRoute | S04172 | Cancelado | DOWNSELL | `4910d30d` | 2026-06-28 | 2027-01-27 | 2026-06..2026-12 | 7 | -2,91 CLF | −125 | 501 | no |
| SimpliRoute | S04620 | Activo | DOWNSELL | `18ce9a32` | 2026-09-12 | 2027-08-31 | 2026-09..2027-08 | 12 | -10,24 CLF | −440 | 279 | no |
| SimpliRoute | S04620 | Activo | DOWNSELL | `526e2268` | 2026-09-01 | 2027-09-24 | 2026-09..2027-08 | 12 | -1,16 CLF | −50 | 50 | **sí** |
| SimpliRoute | S06426 | Activo | DOWNSELL | `a61197b7` | 2026-07-07 | 2027-01-06 | 2026-07..2026-12 | 6 | -475,98 PEN | −140 | 420 | no |
| SimpliRoute | S06461 | Activo | DOWNSELL | `19ef6c4d` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -10,80 CLF | −464 | 929 | no |
| SimpliRoute | S06619 | Activo | DOWNSELL | `e56e2b49` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -8,05 CLF | −346 | 1.038 | no |
| SimpliRoute | S06975 | Activo | DOWNSELL | `9e3a8d87` | 2026-08-13 | 2027-01-12 | 2026-08..2026-12 | 5 | -17952,00 MXN | −945 | 1.890 | no |
| SimpliRoute | S07212 | Activo | DOWNSELL | `b7941399` | 2026-09-01 | 2026-12-31 | 2026-09..2026-12 | 4 | -12447,24 MXN | −655 | 655 | no |
| SimpliRoute | S07212 | Activo | DOWNSELL | `bb19ec2e` | 2026-09-01 | 2026-12-31 | 2026-09..2026-12 | 4 | -627,00 MXN | −33 | 33 | no |
| SimpliRoute | S07440 | Activo | DOWNSELL | `8580d834` | 2026-06-22 | 2027-01-21 | 2026-06..2026-12 | 7 | -1,92 CLF | −83 | 330 | no |
| SimpliRoute | S07608 | Activo | DOWNSELL | `2c03cd71` | 2026-09-29 | 2027-01-28 | 2026-09..2026-12 | 4 | -12122,82 MXN | −638 | 43 | **sí** |
| SimpliRoute | S07723 | Activo | DOWNSELL | `9a390ce2` | 2026-08-01 | 2026-12-31 | 2026-08..2026-12 | 5 | -10,50 CLF | −452 | 903 | no |
| SimpliRoute | S07743 | Activo | DOWNSELL | `feac6557` | 2026-07-01 | 2026-12-31 | 2026-07..2026-12 | 6 | -204592,41 COP | −53 | 159 | no |
| TiMining | BAM-01 | Activo | DOWNSELL | `1d3bc8da` | 2025-12-01 | 2026-01-31 | 2025-12..2026-01 | 2 | -4166,67 USD | −4.167 | 8.333 | no |
| TiMining | BAM-01 | Activo | DOWNSELL | `1d847fb6` | 2025-12-01 | 2026-01-31 | 2025-12..2026-01 | 2 | -416,67 USD | −417 | 833 | no |
| TiMining | CHI-01 | Activo | DOWNSELL | `3c67e5a4` | 2025-10-01 | 2026-01-31 | 2025-10..2026-01 | 4 | -25000,00 USD | −25.000 | 100.000 | no |
| uPlanner | 165 | Cancelado | CHURN | `056adfb1` | 2026-07-01 | 2027-06-30 | 2026-07..2027-06 | 12 | -10687500,00 COP | −2.800 | 8.399 | no |
| uPlanner | 165 | Cancelado | CHURN | `5f942de8` | 2026-07-01 | 2027-06-30 | 2026-07..2027-06 | 12 | -10687500,00 COP | −2.800 | 8.399 | no |
| uPlanner | 194 | Cancelado | CHURN | `5300ad4e` | 2025-07-01 | 2026-06-30 | 2025-07..2026-06 | 12 | -1833,00 USD | −1.833 | 21.996 | no |
| uPlanner | 194 | Cancelado | CHURN | `6c945b91` | 2025-07-01 | 2026-06-30 | 2025-07..2026-06 | 12 | -1833,00 USD | −1.833 | 21.996 | no |
| uPlanner | 113 | Activo | DOWNSELL | `47b3376e` | 2026-07-01 | 2026-11-30 | 2026-07..2026-11 | 5 | -134,17 CLF | −5.808 | 17.425 | no |

## Anexo C · Ajustes con fechas a revisar

UPSELL / CROSS-SELL / DOWNSELL recurrentes cuyo fin pasa el fin de los ítems base del contrato (puede ser correcto si la renovación de la base aún no se cargó) o cae a mitad de ciclo (el tramo final no se reconoce: §5.2). Para la corrección de datos; después, rebuild de esos contratos.


| Holding | Contrato | Estado | Categoría | Ítem | Inicio | Fin | Plazo | Fin de los ítems base | Día de ciclo | Observación |
|---|---|---|---|---|---|---|---:|---|---:|---|
| SimpliRoute | CTR-2026-204 | Activo | UPSELL | `35bb87a8` | 2026-09-01 | 2027-08-31 | 12 | 2027-07-31 | 1 | pasa el fin base |
| SimpliRoute | CTR-2026-204 | Activo | UPSELL | `e37bf5f0` | 2026-09-01 | 2027-08-31 | 12 | 2027-07-31 | 1 | pasa el fin base |
| SimpliRoute | CTR-2026-204 | Activo | UPSELL | `d7a25f41` | 2026-09-01 | 2027-09-01 | 12 | 2027-07-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | CTR-2026-204 | Activo | UPSELL | `817a1fc7` | 2026-09-01 | 2027-08-31 | 12 | 2027-07-31 | 1 | pasa el fin base |
| SimpliRoute | CTR-2026-61 | Activo | UPSELL | `cb21f4da` | 2026-08-11 | 2027-01-10 | 5 | 2026-12-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | CTR-2026-86 | Activo | CROSS-SELL | `602b29a4` | 2026-08-01 | 2027-07-31 | 12 | 2026-11-30 | 1 | pasa el fin base |
| SimpliRoute | CTR-2026-86 | Activo | CROSS-SELL | `0f6f1cdc` | 2026-08-01 | 2027-07-31 | 12 | 2026-11-30 | 1 | pasa el fin base |
| SimpliRoute | S01817 | Activo | UPSELL | `bb10a69b` | 2026-07-01 | 2027-06-30 | 12 | 2027-01-27 | 28 | pasa el fin base |
| SimpliRoute | S02762 | Activo | UPSELL | `ac5584ac` | 2026-09-01 | 2027-09-01 | 12 | 2027-01-20 | 21 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S02762 | Activo | UPSELL | `c97daee5` | 2026-08-01 | 2027-07-31 | 12 | 2027-01-20 | 21 | pasa el fin base |
| SimpliRoute | S04138 | Activo | UPSELL | `328fa81b` | 2026-07-01 | 2027-06-30 | 12 | 2027-01-11 | 12 | pasa el fin base |
| SimpliRoute | S04151 | Activo | UPSELL | `1d37b6c3` | 2026-07-14 | 2027-07-13 | 12 | 2027-01-24 | 25 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S04170 | Activo | UPSELL | `84e11451` | 2026-06-26 | 2027-06-25 | 12 | 2027-01-24 | 25 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S04191 | Activo | UPSELL | `c7ecf000` | 2026-06-30 | 2027-01-29 | 7 | 2027-01-24 | 25 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S04620 | Activo | CROSS-SELL | `047bc19f` | 2026-08-25 | 2027-09-24 | 13 | 2027-08-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S04620 | Activo | DOWNSELL | `526e2268` | 2026-09-01 | 2027-09-24 | 12 | 2027-08-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S07093 | Activo | UPSELL | `469ea4c3` | 2026-06-01 | 2027-01-31 | 8 | 2027-01-27 | 28 | pasa el fin base |
| SimpliRoute | S07146 | Activo | UPSELL | `4ec8e450` | 2026-08-15 | 2027-08-14 | 12 | 2027-01-14 | 15 | pasa el fin base |
| SimpliRoute | S07146 | Activo | UPSELL | `26521dc7` | 2026-09-15 | 2027-09-14 | 12 | 2027-01-14 | 15 | pasa el fin base |
| SimpliRoute | S07244 | Activo | UPSELL | `3171d9c0` | 2026-07-01 | 2027-06-30 | 12 | 2026-12-31 | 1 | pasa el fin base |
| SimpliRoute | S07276 | Activo | UPSELL | `ad5eb4cd` | 2026-08-05 | 2027-08-05 | 12 | 2026-12-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S07495 | Activo | CROSS-SELL | `45194a0d` | 2026-08-01 | 2027-07-31 | 12 | 2026-12-31 | 1 | pasa el fin base |
| SimpliRoute | S07608 | Activo | DOWNSELL | `2c03cd71` | 2026-09-29 | 2027-01-28 | 4 | 2027-01-26 | 27 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S07608 | Activo | UPSELL | `946abca3` | 2026-08-01 | 2027-07-31 | 12 | 2027-01-26 | 27 | pasa el fin base |
| SimpliRoute | S07742 | Activo | UPSELL | `2fffcbd6` | 2026-07-07 | 2027-01-06 | 6 | 2026-12-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| SimpliRoute | S07866 | Activo | UPSELL | `a9749fa2` | 2026-09-01 | 2027-08-31 | 12 | 2026-12-31 | 1 | pasa el fin base |
| SimpliRoute | S07866 | Activo | UPSELL | `7432fe25` | 2026-09-01 | 2027-08-31 | 12 | 2026-12-31 | 1 | pasa el fin base |
| SimpliRoute | S07866 | Activo | UPSELL | `5ea4da9d` | 2026-08-21 | 2027-08-21 | 12 | 2026-12-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| TiMining | AMS-01 | Activo | CROSS-SELL | `5da51372` | 2026-05-01 | 2027-04-30 | 12 | 2026-05-31 | 1 | pasa el fin base |
| TiMining | ANG-01 | Activo | CROSS-SELL | `482ab70c` | 2025-08-11 | 2026-08-10 | 12 | 2027-11-30 | 1 | fin a mitad de ciclo |
| TiMining | ANG-02 | Activo | CROSS-SELL | `a424c3c1` | 2026-05-01 | 2027-04-30 | 12 | 2027-01-31 | 1 | pasa el fin base |
| TiMining | ASA-01 | Activo | CROSS-SELL | `a1b2c3d4` | 2025-05-01 | 2026-07-31 | 15 | 2025-10-31 | 1 | pasa el fin base |
| TiMining | CHI-01 | Activo | UPSELL | `def5f34d` | 2026-03-24 | 2027-03-23 | 12 | 2026-01-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| TiMining | CHI-01 | Activo | CROSS-SELL | `d9c530b3` | 2025-03-24 | 2027-03-23 | 24 | 2026-01-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| TiMining | COD-01 | Activo | CROSS-SELL | `e99d962d` | 2025-06-18 | 2027-06-17 | 24 | 2026-08-31 | 1 | pasa el fin base; fin a mitad de ciclo |
| TiMining | COL-01 | Activo | CROSS-SELL | `6c7f4a92` | 2026-09-01 | 2027-08-31 | 12 | 2027-05-31 | 1 | pasa el fin base |
| TiMining | MAS-01 | Activo | CROSS-SELL | `2e172a80` | 2026-08-01 | 2027-01-31 | 6 | 2026-12-03 | 4 | pasa el fin base |
| TiMining | PEL-01 | Activo | CROSS-SELL | `20ef65b8` | 2025-01-01 | 2026-12-31 | 24 | 2026-02-28 | 1 | pasa el fin base |
| TiMining | PEL-01 | Activo | CROSS-SELL | `9839d1a3` | 2025-01-01 | 2026-12-31 | 24 | 2026-02-28 | 1 | pasa el fin base |
| TiMining | PEL-01 | Activo | CROSS-SELL | `8b8b78ab` | 2025-06-01 | 2026-05-31 | 12 | 2026-02-28 | 1 | pasa el fin base |
| TiMining | PEL-01 | Activo | UPSELL | `69db853b` | 2025-05-01 | 2026-04-30 | 12 | 2026-02-28 | 1 | pasa el fin base |
| TiMining | PEL-01 | Activo | CROSS-SELL | `5caf7f4e` | 2025-01-01 | 2026-12-31 | 24 | 2026-02-28 | 1 | pasa el fin base |
| TiMining | SCO-01 | Activo | UPSELL | `1d9a5fdb` | 2026-05-01 | 2027-04-30 | 12 | 2026-09-30 | 1 | pasa el fin base |
