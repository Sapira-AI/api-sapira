# Auditoría de datos por holding antes del switch

> Auditoría **solo lectura** de producción (2026-10-03, Claude para Domi). No se corrigió nada: cada hallazgo trae la consulta
> con que se midió y una propuesta (corregir antes del switch / corregir después / decidir con Domi / no tocar). Complementa
> [`estado-v2-y-plan-switch.md`](./estado-v2-y-plan-switch.md) §4 y §5 (hallazgos ya anotados) y
> [`auditoria-contratos.md`](./auditoria-contratos.md). Al resolver un punto se marca aquí, no se crea otro documento.

## 0. Cómo se midió

- Cada consulta corrió como `BEGIN TRANSACTION READ ONLY; <SELECT>; ROLLBACK;` contra `.env.prod.db` (nunca `SET SESSION`):

  ```bash
  (cd api-sapira; set -a; . ./.env.prod.db; set +a; U="${SUPABASE_DATABASE_URL%%\?*}"; \
   psql "$U" -At -c "BEGIN TRANSACTION READ ONLY; SELECT ...; ROLLBACK;")
  ```

- Holdings: SimpliRoute `5652e95e…` (SR), TiMining `49763a7a…` (TM), uPlanner `f6e3cb81…` (UP), Lenosoft `c97951be…` (LS),
  Hanka `05583c6e…` (HK, demo). "Empresa de dominique zamora" y "Empresa de Over Martinez" no tienen datos de negocio (solo
  catálogos por defecto y 3 usuarios cada uno): no se auditan.
- Volumen vivo: SR 1.653 clientes / 567 contratos / 8.686 facturas / 406 cotizaciones / 11.848 filas de MRR legacy; TM 64 / 45 / 297;
  UP 77 / 62 / 398; LS 1 / 1 / 24; HK 21 / 25 / 468 / 25 cotizaciones.
- "Factura viva" = `is_active` y `status <> 'Cancelada'`. "Emitida" = `Emitida`, `Enviada`, `Pagada` o `Vencida`.
- Corte de reglas v2 del devengo: `revenue_schedule_rebuild_contract_ccy` se aplicó en producción el **2026-10-01 23:19 UTC** y
  `revenue_schedule_rebuild` el **2026-10-02 01:17 UTC** (`sapira_sql_asset_history`). Una fila RSM con `updated_at` anterior a
  ese momento se calculó con reglas previas.
- Las consultas están en el §8 con un código (Q1, Q2…); las tablas por holding las citan.

## 1. Resumen priorizado

**Corregir antes del switch** (lo ve el usuario el primer día en el front nuevo):

1. **Devengo de suscripciones de Stripe congelado en abril 2026 (SR).** Las filas RSM de suscripciones se calcularon por última vez
   el 15-04-2026 y llegan hasta 2026-04. Hay 155 suscripciones activas (≈31 mil USD de MRR) y 22 en `past_due` (≈4 mil USD); 21 activas
   no tienen ninguna fila. Desde mayo 2026, Ingresos y Métricas de SR no ven el MRR de Stripe (≈31–35 mil USD/mes). Va dentro del
   rebuild (Q20, Q21).
2. **Rebuild del devengo** (ya en el plan, §5.3): solo 53 de 687 contratos con RSM están completos con reglas v2. SR: 432 contratos
   todo con reglas anteriores y 116 mezclados (rebuild parcial: los meses anteriores al `p_from_month` quedaron con reglas viejas);
   TM 32, UP 50, LS 1 sin v2. 65 contratos tuvieron cambios después de su último cálculo (Q17).
3. **Montos en moneda del sistema mal calculados**: SR 36 facturas vivas en CLP (16 emitidas, 20 Por Emitir) sin convertir o con
   la tasa invertida; UP 13 facturas CLF Por Emitir con tasa errónea y 12 emitidas sin monto en moneda del sistema; TM 3; LS 24
   facturas sin monto de sistema e IVA calculado con 0,19 % (Q2, Q3, Q8). Afecta Cobranza, KPI y el envío al ERP de las Por Emitir.
4. **Notas de crédito "Vencida" y facturas anuladas por NC que siguen "Vencida"** (SR 25 + 18, UP 2): inflan cuentas por cobrar y la
   cobranza del front nuevo las mostraría como deuda (Q14, Q15).
5. **Lenosoft**: impuesto 0.19 en sus 2 compañías, 24 facturas Por Emitir con IVA 0,01 UF y monto de sistema 0, 17 de ellas atrasadas
   más de 30 días (desde 2025-05) y moneda de compañía USD con sistema CLP. Es un holding de 1 cliente: se corrige completo antes
   del switch (Q8, Q9).

**Decidir con Domi** (tocan datos de clientes; caso a caso):

6. **Bajas y contracciones del modelo anterior como ítem negativo**: 92 ítems en 80 contratos (SR 70, TM 2, UP 3, HK 5), de los
   que 23 contratos siguen Activos. A septiembre 2026 inflan el diferido por ítem en ≈60 mil USD en SR, 100 mil en TM y 34 mil en UP;
   en SR generaron 5 facturas Por Emitir negativas (un contrato). La cifra anotada antes (43/1/1) usaba otro criterio; hoy se
   cuentan CHURN y DOWNSELL (Q1).
7. **28 cotizaciones del CRM en "Enviada" con contrato** (SR): confirmado, 28 (Q5).
8. **RUT/identificador tributario**: 389 razones sociales de SR con el id de cliente de Stripe (`cus_…`) como identificador tributario
   (386 con facturas); 5 con "NICOLA"; 10 RUT chilenos sin guion en UP; puntos o `k` minúscula en SR, HK y LS (Q10). Duplicados
   reales por identificador normalizado: SR 11 grupos, UP 2 (sin contar los genéricos de extranjero 55.555.555-5 y XEXX010101000,
   que son correctos) (Q11).
9. **Industrias duplicadas inglés/español en SR** (55 valores del catálogo) y 124 clientes con 3 valores fuera del catálogo
   (`Retail/Minorista` 110, `Industria Manufacturera` 11, `Servicios Públicos` 3) (Q12).
10. **Contratos "Activo" con todos los ítems vencidos** (SR 3, TM 6, UP 14) y fin de contrato distinto del fin de sus ítems
    (SR 84, TM 19, UP 26, HK 2, LS 1) (Q16).

**Corregir después del switch / no tocar**: cabeceras de factura distintas de sus líneas fuera de Hanka (son pocas y casi todas
históricas), tasa futura faltante en 33 contratos (meses 2026-11 a 2028), clientes sin país en SR (679), países: **ya no hay** valores
sin calce ISO (todos los que tienen país tienen `country_code`), números de cotización: **ya no hay** duplicados (solo 3 cotizaciones
manuales con número vacío).

## 2. SimpliRoute

| # | Qué | Cuántos | Consulta | Impacto en el usuario | Propuesta |
|---|---|---|---|---|---|
| SR-1 | Ítems de precio negativo del modelo anterior | 79 ítems en 70 contratos: CHURN 58 ítems / 54 contratos (todos Cancelados), DOWNSELL 21 / 18 (16 Activos). 4 contratos Cancelados quedan con neto mensual negativo | Q1 | Diferido por ítem inflado ≈59,8 mil USD a sep-2026 (CHURN 52,4 mil + DOWNSELL 7,4 mil); MRR negativo por ítem (−27,9 mil USD en sep-2026, se netea por contrato); facturas negativas (SR-6) | Decidir con Domi, caso a caso |
| SR-2 | Facturas CLP con monto en moneda del sistema mal calculado | 36 vivas: 29 sin convertir (monto USD = monto CLP), 7 con tasa fuera de rango. 16 emitidas (2 Enviada, 1 Pagada, 13 Vencida), 20 Por Emitir. Dos causas: contratos CLF facturados en CLP con `fx_contract_to_system` = 0,023255 (tasa invertida USD→CLF) y facturas `Unificada` con tasa 1,0 | Q2, Q3 | KPI y cobranza en USD inflados en cientos de millones; aparece en Cobranza, Facturación e Ingresos | Corregir antes del switch (emitidas: recalcular monto de sistema; Por Emitir: se recalculan al emitir, pero revisar que la API v2 no herede la tasa invertida) |
| SR-3 | Otras monedas con monto de sistema fuera de rango | USD 14 (8 Por Emitir), PEN 2 | Q3 | Menor | Corregir después |
| SR-4 | Facturas CLF→CLP Por Emitir con monto en CLP igual al monto en UF | 14 (3 contratos, 2026-11 a 2027-08) + 1 Pagada; además 2 COP Vencida con el mismo problema | Q4 | Si se emiten así, la factura sale por 5–16 pesos | Corregir antes del switch |
| SR-5 | 28 cotizaciones del CRM en "Enviada" con contrato | 28 (además 116 en "Contrato creado" correctas) | Q5 | La línea de etapas y el embudo de Cotizaciones muestran negocios cerrados como abiertos | Decidir con Domi (ya anotado) |
| SR-6 | Facturas Por Emitir de contratos Cancelados | 11 (5 negativas de un contrato con baja como ítem negativo, 3 iguales de 588,25 USD de un contrato con baja 01-10, 1 de 624.925 CLP posterior a la baja) | Q6 | Se ofrecerían para emitir facturas de clientes dados de baja, algunas negativas | Corregir antes del switch (anular o decidir caso a caso) |
| SR-7 | Facturas Por Emitir sin contrato (Stripe) | 12: 5 de suscripciones canceladas (2025-01 a 2026-03) y 7 sin suscripción | Q7 | Aparecen en Por Emitir sin forma de emitirlas desde Sapira | Decidir con Domi (Leon: sync de Stripe) |
| SR-8 | Facturas de Stripe sin contrato ni suscripción | 84 (58 Pagada, 10 Vencida, 9 Emitida, 7 Por Emitir) | Q7b | No entran al devengo; además SR tiene 35 facturas vivas sin cliente (Q9) | Decidir con Domi / Leon |
| SR-9 | Notas de crédito en estado "Vencida" | 25 | Q14 | Restan o suman en cuentas por cobrar como deuda vencida | Corregir antes del switch |
| SR-10 | Facturas anuladas por NC por el total que siguen "Vencida" | 18 | Q15 | Deuda inexistente en Cobranza | Corregir antes del switch |
| SR-11 | Facturas emitidas sin número | 26 (25 Automática Vencida, 1 Unificada), todas de más de 30 días; 35 emitidas sin id del ERP | Q13 | No se pueden identificar ni conciliar | Decidir con Domi |
| SR-12 | Facturas Por Emitir atrasadas | 178 automáticas con fecha de emisión pasada hace más de 30 días (36 más de 180), 5 manuales, 12 de Stripe | Q19 | Ruido en Tareas y Por Emitir del día 1 | Decidir con Domi (limpiar o emitir) |
| SR-13 | Cabecera de factura distinta de la suma de sus líneas (neto) | 84 vivas (40 Por Emitir automáticas, 26 Pagada de Stripe, el resto emitidas) y 8 sin líneas | Q8b | La vista rápida muestra un total y un detalle que no cuadran | Corregir Por Emitir antes; históricas después |
| SR-14 | Razones sociales con id de Stripe como identificador tributario | 389 (`cus_…`), 386 con facturas | Q10 | Se ven como "RUT" en Clientes y no calzan con el ERP | Decidir con Domi |
| SR-15 | Otros identificadores mal normalizados | 5 "NICOLA", 1 "#Nicola", 2 con `k` minúscula, 1 con puntos, 1 de 9 dígitos sin guion, 7+ vacíos, ~22 con letras fuera de México | Q10 | Búsqueda por RUT y emisión fallan | Corregir antes del switch los de Chile; el resto después |
| SR-16 | Razones sociales duplicadas por identificador normalizado | 11 grupos reales (sin contar 555555555, NICOLA y XEXX010101000) | Q11 | Clientes repetidos en listas y 360 | Decidir con Domi |
| SR-17 | Clientes duplicados por nombre comercial normalizado | 7 nombres, 14 clientes (1 con contrato) | Q11b | Igual que SR-16 | Decidir con Domi |
| SR-18 | Industrias duplicadas inglés/español | Catálogo de 55 valores con pares (Automotriz/automotive, Transporte/Transportation/…, Food & Beverage/food & beverages, Salud/Healthcare, Banking/Finance/Banca…); 124 clientes con valores fuera del catálogo | Q12 | Filtros y KPI por industria partidos | Decidir con Domi (mapa de equivalencias) y corregir antes |
| SR-19 | Clientes y razones sociales sin país | 679 clientes, 159 razones sociales | Q12b | Sin impuesto ni documento tributario por país | Corregir después |
| SR-20 | Contratos Activos con todos los ítems vencidos | 3 | Q16 | Aparecen como vigentes | Corregir antes (vencer o renovar) |
| SR-21 | Fin de contrato distinto del fin de sus ítems | 84 | Q16 | Alertas de vencimiento y renovaciones mal fechadas | Decidir con Domi |
| SR-22 | Ítems con baja anterior a su inicio | 2 | Q16b | Devengo raro en esos ítems | Corregir después |
| SR-23 | Facturas con vencimiento anterior a la emisión | 14 | Q16c | Mora calculada mal | Corregir después |
| SR-24 | Facturas con moneda de factura distinta de la del contrato | 3 (y 14 con moneda de contrato distinta) | Q18 | Menor | No tocar / revisar con Leon |
| SR-25 | Facturas con razón social no vinculada al cliente de la factura | 37 | Q9b | Factura aparece en un cliente y la razón social en otro | Decidir con Domi |
| SR-26 | Contratos "En revisión" sin devengo | 14 (13 sin RSM) | Q17 | Ninguno mientras no se activen | No tocar |
| SR-27 | Devengo: contratos sin reglas v2 | 432 todo con reglas anteriores, 116 mezclados, 6 todo v2; 63 con cambios después de su último cálculo | Q17 | Ingresos y Métricas mezclan reglas | Rebuild antes del switch (§5.3) |
| SR-28 | Devengo de suscripciones de Stripe congelado | Filas hasta 2026-04, último cálculo 15-04-2026; 155 activas (≈31 mil USD), 21 activas sin filas | Q20, Q21 | MRR de Stripe ausente desde mayo 2026 | Corregir antes del switch |
| SR-29 | Meses futuros sin tasa (UYU) | 66 filas, 26 contratos, 2026-11 y 2026-12 | Q22 | Proyección en moneda de compañía vacía | Corregir después (tasa proyectada) |
| SR-30 | Usuarios con invitación pendiente | 4 | Q23 | Ya anotado en §4 | Decidir con Domi |
| SR-31 | Números de cotización | Sin duplicados; 3 cotizaciones manuales con número vacío (07-2026, 09-2026, 10-2026). No hay índice único en producción | Q5b | Bloquea el UNIQUE parcial | Corregir antes (asignar número) y crear el índice |

## 3. TiMining

| # | Qué | Cuántos | Consulta | Impacto | Propuesta |
|---|---|---|---|---|---|
| TM-1 | Ítems negativos (DOWNSELL) | 3 ítems en 2 contratos Activos | Q1 | Diferido por ítem inflado en 100 mil USD a sep-2026 | Decidir con Domi |
| TM-2 | Facturas CLP sin monto en moneda del sistema | 3 Por Emitir | Q3 | Faltan en KPI en USD | Corregir antes |
| TM-3 | Facturas cuyo cliente no es el del contrato | 18 Pagada en 8 contratos | Q9 | En el Cliente 360 las facturas aparecen en otro cliente | Decidir con Domi |
| TM-4 | Facturas Por Emitir con moneda de factura distinta de la del contrato | 14 | Q18 | Se emitirían en otra moneda que la pactada | Decidir con Domi |
| TM-5 | Nota de crédito Por Emitir positiva y sin factura de origen | 1 | Q14 | No se puede emitir válidamente | Corregir antes |
| TM-6 | Folio repetido entre emitidas | 1 número, 2 facturas | Q13b | Conciliación ambigua | Corregir después |
| TM-7 | Cabecera ≠ líneas (neto) | 10 (7 Por Emitir) | Q8b | Total y detalle no cuadran | Corregir las Por Emitir antes |
| TM-8 | 24 razones sociales extranjeras con RUT genérico 55.555.555-5 | 24 | Q11 | Correcto según SII | No tocar |
| TM-9 | Contratos Activos con todos los ítems vencidos | 6 | Q16 | Aparecen vigentes | Corregir antes |
| TM-10 | Fin de contrato ≠ fin de ítems; Cancelado sin fecha de baja | 19; 1 | Q16 | Alertas y bajas mal fechadas | Decidir con Domi |
| TM-11 | Vencimiento anterior a la emisión | 11 | Q16c | Mora mal calculada | Corregir después |
| TM-12 | Por Emitir atrasadas | 10 automáticas (+30 días), 2 manuales | Q19 | Ruido en Tareas | Decidir con Domi |
| TM-13 | Devengo sin reglas v2 | 32 de 45 contratos (31 Activos); 2 con cambios posteriores al cálculo | Q17 | Mezcla de reglas | Rebuild |
| TM-14 | Meses futuros sin tasa (2028) | 55 filas, 3 contratos | Q22 | Proyección incompleta | Corregir después |
| TM-15 | Países con texto en inglés ("USA", "EEUU") | 5, con ISO correcto | Q12c | Ninguno | No tocar |
| TM-16 | Segmento fuera del catálogo | 1 cliente | Q12 | Menor | Corregir después |

## 4. uPlanner

| # | Qué | Cuántos | Consulta | Impacto | Propuesta |
|---|---|---|---|---|---|
| UP-1 | Ítems negativos | CHURN 4 ítems / 2 contratos Cancelados, DOWNSELL 1 / 1 Activo | Q1 | Diferido por ítem inflado ≈34 mil USD a sep-2026 | Decidir con Domi |
| UP-2 | Facturas CLF Por Emitir con tasa a USD errónea | 13 (monto de sistema ≈20 veces menor) | Q3 | KPI de Por Emitir subestimado | Corregir antes |
| UP-3 | Facturas emitidas sin monto en moneda del sistema | 12 (9 EUR, 2 CLP, 1 MXN, todas Pagada) | Q3 | Faltan en métricas de cobranza en USD | Corregir antes |
| UP-4 | Factura MXN con monto igual al de USD | 1 Vencida (negativa) | Q4 | Menor | Corregir después |
| UP-5 | Contrato Cancelado con Por Emitir posterior a la baja y fin anterior a la baja | 1 (EUR 3.500) | Q6 | Se ofrecería emitir | Corregir antes |
| UP-6 | Notas de crédito "Vencida" | 2 | Q14 | Deuda negativa vencida | Corregir antes |
| UP-7 | Folios repetidos entre emitidas | 5 números, 12 facturas | Q13b | Conciliación ambigua | Decidir con Domi |
| UP-8 | Factura emitida sin número | 1 | Q13 | No identificable | Corregir después |
| UP-9 | Posible factura duplicada | 1 par Pagada (mismo contrato, fecha, monto, ítems y período) | Q24 | Cobro doble aparente | Decidir con Domi |
| UP-10 | RUT chilenos sin guion ni dígito verificador separado | 10 | Q10 | Búsqueda por RUT y ERP | Corregir antes |
| UP-11 | Razones sociales duplicadas por identificador | 2 grupos reales (+14 con 55.555.555-5, correcto) | Q11 | Clientes repetidos | Decidir con Domi |
| UP-12 | Baja posterior al fin del contrato | 5; 1 Activo con baja pasada | Q16 | Estados y fechas incoherentes | Decidir con Domi |
| UP-13 | Contratos Activos con todos los ítems vencidos | 14 | Q16 | Aparecen vigentes | Corregir antes |
| UP-14 | Fin de contrato ≠ fin de ítems | 26 | Q16 | Alertas mal fechadas | Decidir con Domi |
| UP-15 | Vencimiento anterior a la emisión | 25 | Q16c | Mora mal calculada | Corregir después |
| UP-16 | Por Emitir atrasadas | 32 (+30 días), 3 de más de 180 | Q19 | Ruido en Tareas | Decidir con Domi |
| UP-17 | Devengo sin reglas v2 | 50 de 62 contratos (43 Activos) | Q17 | Mezcla de reglas | Rebuild |
| UP-18 | Meses futuros sin tasa (CLF 2027, USD 2028) | 48 filas, 4 contratos; la fila CLF deja el MRR en USD vacío | Q22 | Proyección y MRR 2027 incompletos | Corregir después |
| UP-19 | Moneda de factura vacía en el contrato | 53 contratos | Q18b | La API v2 debe tomar la del contrato | No tocar (verificar default) |

## 5. Lenosoft

| # | Qué | Cuántos | Consulta | Impacto | Propuesta |
|---|---|---|---|---|---|
| LS-1 | Impuesto 0.19 (decimal) en las compañías | 2 compañías | Q9c | IVA de 0,19 % | Corregir antes (19) |
| LS-2 | Facturas con IVA calculado al 0,19 % y monto de sistema 0 | 24 Por Emitir (CLF, IVA 0,01 UF en vez de 0,665) | Q8 | Se emitirían con IVA errado | Corregir antes |
| LS-3 | Por Emitir atrasadas | 17 de más de 30 días, 12 de más de 180 (desde 2025-05) | Q19 | Tareas con deuda falsa | Decidir con Domi |
| LS-4 | Moneda de compañía USD con moneda de sistema CLP | 2 compañías | Q9c | Asientos y devengo en moneda de compañía errados | Decidir con Domi |
| LS-5 | Ítem sin producto | 1 (el único contrato) | Q1b | No se envía al ERP | Corregir antes |
| LS-6 | RUT con puntos | 1 | Q10 | Menor | Corregir antes |
| LS-7 | Cuenta auth huérfana (sin usuario en Sapira) | 1 (dominio lenosoft.cl, último ingreso 2025-10-04) | Q23b | Ninguno | Decidir con Domi (borrar en Auth) |
| LS-8 | Devengo sin reglas v2; fin de contrato ≠ ítems | 1 contrato | Q17, Q16 | Mezcla de reglas | Rebuild |

## 6. Hanka (demo)

| # | Qué | Cuántos | Consulta | Impacto | Propuesta |
|---|---|---|---|---|---|
| HK-1 | Cabecera de factura distinta de sus líneas | 130 (68 Pagada, 54 Por Emitir, 8 Vencida); 22 Por Emitir además con IVA distinto | Q8b | La demo muestra totales que no cuadran | Corregir antes (es la demo de ventas) |
| HK-2 | Ítems negativos | 5 (4 DOWNSELL Activos, 1 CHURN) | Q1 | Diferido inflado 3 mil USD | Corregir antes (datos de demo) |
| HK-3 | Facturas con razón social o compañía distinta de la del contrato | 30 / 18 | Q9 | Demo incoherente | Corregir antes |
| HK-4 | Facturas con moneda distinta de la del contrato | 18 (7 Por Emitir) | Q18 | Menor | Corregir después |
| HK-5 | Ítem con moneda distinta de la del contrato | 1 | Q18 | Menor | Corregir después |
| HK-6 | Usuario con `auth_id` huérfano | 1 (Activo) | Q23b | No puede entrar | Decidir con Domi |
| HK-7 | RUT con puntos | 4 CL, 3 CO, 1 BR | Q10 | Menor | Corregir antes |
| HK-8 | Mercado fuera del catálogo ("Latam sur") | 9 clientes | Q12 | Filtro incompleto | Corregir antes |
| HK-9 | Folio repetido | 1 número, 2 facturas | Q13b | Menor | Corregir después |
| HK-10 | Notas de crédito Por Emitir | 17 | Q14 | Ninguno (demo) | No tocar |
| HK-11 | Devengo | 22 de 25 contratos con v2 | Q17 | — | Rebuild con los demás |

## 7. Devengo: tamaño del rebuild

**Frescura por contrato** (Q17; contratos no borrados con filas RSM):

| Holding | Con RSM | Todo v2 | Mezclado | Todo anterior | Activos sin v2 | Cambios posteriores al último cálculo |
|---|---|---|---|---|---|---|
| SR | 554 | 6 | 116 | 432 | 378 | 63 |
| TM | 45 | 13 | 0 | 32 | 31 | 2 |
| UP | 62 | 12 | 0 | 50 | 43 | 0 |
| LS | 1 | 0 | 0 | 1 | 1 | 0 |
| HK | 25 | 22 | 0 | 3 | 0 | 0 |

"Mezclado" = el contrato se recalculó con `p_from_month` y los meses previos conservan filas de las reglas anteriores (U8).
"Cambios posteriores" = el último registro en `contract_change_log`, `contract_item_change_log`, `quantities`, `consumption_entries`
o `invoices.sent_at` es posterior al último cálculo. No hay filas RSM huérfanas (contrato o ítem inexistente) ni ítems Activos/Cancelados
sin RSM. Los períodos cerrados de SR (corte 2024-12-31, 2025-06-30 y 2025-08-31 según la compañía; las demás compañías sin cierre)
deben revisarse antes del rebuild, como pide el §5.3.

**Dónde cambiaría el número** (estimación sin escribir: no se ejecutó ninguna función):

- Meses completos: en los 8.000+ ítem-mes recurrentes sin consumo, el MRR guardado ya coincide con `monthly_price` (0 diferencias,
  Q25): el rebuild no mueve el MRR de régimen.
- Primer mes con prorrateo (U5) de ítems con inicio a mitad de mes calculados con reglas anteriores (Q26): SR CHURN 3, DOWNSELL 8
  (7 contratos), UPSELL 5 (3); UP CROSS-SELL 2. Los NEW/RENEWAL difieren también en filas v2 por el día de ciclo, así que esta
  medición no los separa; se ve en la comparación de QA.
- Saldos (diferido/por facturar) de los 116 contratos mezclados de SR: es donde U8 corrige el arrastre.
- Suscripciones de SR (SR-28): el rebuild agrega desde 2026-05 ≈31–35 mil USD/mes que hoy faltan.
- Ítems negativos (SR-1, TM-1, UP-1): el rebuild **no** los corrige; mantienen el diferido inflado por ítem.

**MRR del devengo vs MRR legacy por mes, SimpliRoute, USD** (único holding con `mrr_legacy`; Q27). "Solapado U14" es lo que el corte
quitaría (legacy migrado a un contrato en meses ≥ primer mes con MRR del contrato):

| Mes | RSM contratos | RSM suscripciones | Legacy bruto | Solapado U14 | Total sin corte | Total con corte |
|---|---|---|---|---|---|---|
| 2024-12 | — | — | 352.384 | — | 352.384 | 352.384 |
| 2025-06 | — | 30.261 | 532.798 | — | 563.059 | 563.059 |
| 2025-12 | 14.838 | 34.333 | 540.018 | — | 589.188 | 589.188 |
| 2026-03 | 32.235 | 40.967 | 524.191 | 63 | 597.393 | 597.329 |
| 2026-04 | 69.346 | 16.164 | 514.517 | 6.504 | 600.026 | 593.522 |
| 2026-05 | 194.086 | **0** | 388.703 | 9.116 | 582.789 | 573.673 |
| 2026-06 | 295.151 | **0** | 244.164 | 15.445 | 539.316 | 523.871 |
| 2026-07 | 436.413 | **0** | 142.867 | 18.759 | 579.280 | 560.522 |
| 2026-08 | 511.092 | **0** | 95.843 | 16.269 | 606.935 | 590.666 |
| 2026-09 | 523.894 | **0** | 47.373 | 368 | 571.267 | 570.898 |
| 2026-10 | 520.093 | **0** | 49.203 | 2.860 | 569.297 | 566.437 |
| 2026-12 | 503.776 | **0** | 47.518 | 2.860 | 551.294 | 548.434 |

El doble conteo sin corte llega a 18,8 mil USD (jul-2026). La caída de "RSM suscripciones" a 0 desde mayo es SR-28, no una baja real.

## 8. Consultas

Todas van dentro de `BEGIN TRANSACTION READ ONLY; …; ROLLBACK;`. `h` = `company_holdings`.

```sql
-- Q1 · ítems de precio negativo por categoría
SELECT h.name, i.categoria, count(*) items, count(DISTINCT c.id) ctr, count(DISTINCT c.id) FILTER (WHERE c.status='Activo') activos
FROM contract_items i JOIN contracts c ON c.id=i.contract_id AND c.deleted_at IS NULL JOIN company_holdings h ON h.id=c.holding_id
WHERE i.price<0 OR i.final_price<0 OR i.monthly_price<0 GROUP BY ROLLUP(1,2);
--   saldos a sep-2026 de esos ítems
SELECT h.name, ci.categoria, count(DISTINCT r.contract_id), sum(r.deferred_balance_eom_system_ccy), sum(r.mrr_period_system_ccy)
FROM revenue_schedule_monthly r JOIN contract_items ci ON ci.id=r.contract_item_id JOIN company_holdings h ON h.id=r.holding_id
WHERE r.period_month='2026-09-01' AND (ci.price<0 OR ci.final_price<0 OR ci.monthly_price<0) GROUP BY 1,2;

-- Q1b · contratos sin ítems / ítems sin producto
SELECT h.name, c.status, count(*) FROM contracts c JOIN company_holdings h ON h.id=c.holding_id
WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM contract_items i WHERE i.contract_id=c.id) GROUP BY 1,2;   -- 0 filas
SELECT h.name, count(*) FROM contract_items i JOIN contracts c ON c.id=i.contract_id AND c.deleted_at IS NULL
JOIN company_holdings h ON h.id=c.holding_id WHERE i.product_id IS NULL GROUP BY 1;

-- Q2 · CLP sin convertir (SR)
SELECT i.status, i.contract_currency, i.fx_contract_to_system, i.invoice_type, count(*)
FROM invoices i WHERE i.holding_id='5652e95e-bb99-48f5-aa1c-13c8c2638fc6' AND i.is_active AND i.invoice_currency='CLP'
  AND i.amount_system_currency<>0 AND i.amount_invoice_currency/i.amount_system_currency < 2 AND i.status<>'Cancelada' GROUP BY 1,2,3,4;

-- Q3 · monto en moneda del sistema fuera de rango (sistema USD)
WITH b(cur, lo, hi) AS (VALUES ('CLP',600,1300),('COP',3000,5000),('MXN',15,23),('PEN',3,4.5),('UYU',35,48),('CLF',0.02,0.04),
  ('EUR',0.8,1.1),('ARS',300,2000),('BRL',4,6.5),('AUD',1.3,1.7),('USD',0.99,1.01))
SELECT h.name, i.invoice_currency, count(*) FILTER (WHERE i.status='Por Emitir'), count(*) FILTER (WHERE i.status<>'Por Emitir'),
  count(*) FILTER (WHERE coalesce(i.amount_system_currency,0)=0)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id JOIN holding_settings hs ON hs.holding_id=i.holding_id AND hs.system_currency='USD'
JOIN b ON b.cur=i.invoice_currency
WHERE i.is_active AND i.status<>'Cancelada' AND coalesce(i.document_type,'')<>'NC' AND i.amount_invoice_currency<>0
  AND (coalesce(i.amount_system_currency,0)=0 OR i.amount_invoice_currency/i.amount_system_currency NOT BETWEEN b.lo AND b.hi)
GROUP BY 1,2;

-- Q4 · monto en moneda de factura igual al de contrato con monedas distintas
SELECT h.name, i.contract_currency, i.invoice_currency, i.status, count(*), min(i.issue_date), max(i.issue_date)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status<>'Cancelada' AND i.invoice_currency<>i.contract_currency
  AND abs(i.amount_invoice_currency - i.amount_contract_currency) < 0.01 AND i.amount_invoice_currency<>0 GROUP BY 1,2,3,4;

-- Q5 · cotizaciones con contrato por tipo de etapa (la lista de las 28: consulta de estado-v2-y-plan-switch.md §5.2)
SELECT h.name, s.kind, count(DISTINCT q.id) FILTER (WHERE q.salesforce_opportunity_id IS NOT NULL) crm, count(DISTINCT q.id) FILTER (WHERE q.salesforce_opportunity_id IS NULL) manual
FROM quotes q JOIN quote_stages s ON s.id=q.quote_stage_id JOIN company_holdings h ON h.id=q.holding_id
JOIN contracts c ON c.deleted_at IS NULL AND (c.quote_id=q.id OR EXISTS (SELECT 1 FROM contract_items ci JOIN quote_items qi ON qi.id=ci.quote_item_id
  WHERE ci.contract_id=c.id AND qi.quote_id=q.id))
WHERE q.deleted_at IS NULL GROUP BY 1,2;

-- Q5b · números de cotización repetidos (incluye borradas, normalizado) e índices
SELECT h.name, upper(btrim(quote_number)), count(*), count(deleted_at) FROM quotes q JOIN company_holdings h ON h.id=q.holding_id
GROUP BY 1,2 HAVING count(*)>1;
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='quotes';

-- Q6 · Por Emitir de contratos no Activos
SELECT h.name, c.status, count(*) FROM invoices i JOIN contracts c ON c.id=i.contract_id AND c.deleted_at IS NULL
JOIN company_holdings h ON h.id=i.holding_id WHERE i.is_active AND i.status='Por Emitir' AND c.status<>'Activo' GROUP BY 1,2;

-- Q7 · Por Emitir sin contrato (y estado de la suscripción)  /  Q7b · sin contrato ni suscripción (cualquier estado)
SELECT h.name, i.invoice_type, s.status, count(*), min(i.issue_date), max(i.issue_date)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id LEFT JOIN subscriptions s ON s.id=i.subscription_id
WHERE i.status='Por Emitir' AND i.contract_id IS NULL GROUP BY 1,2,3;
SELECT h.name, i.status, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.contract_id IS NULL AND i.subscription_id IS NULL GROUP BY 1,2;

-- Q8 · tasa de impuesto decimal en facturas
SELECT h.name, i.tax_rate, i.status, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.tax_rate>0 AND i.tax_rate<1 GROUP BY 1,2,3;

-- Q8b · cabecera (neto) distinta de la suma de líneas
WITH l AS (SELECT invoice_id, sum(subtotal_invoice_currency) sub FROM invoice_items GROUP BY 1)
SELECT h.name, i.invoice_type, i.status, count(*) FILTER (WHERE l.invoice_id IS NULL) sin_lineas, count(*) FILTER (WHERE l.invoice_id IS NOT NULL) distinto
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id LEFT JOIN l ON l.invoice_id=i.id
WHERE i.is_active AND i.status<>'Cancelada'
  AND (l.invoice_id IS NULL OR abs(coalesce(i.amount_invoice_currency,0)-coalesce(l.sub,0)) > greatest(1, 0.005*abs(i.amount_invoice_currency)))
GROUP BY 1,2,3;
-- (el total con IVA no se usa: las líneas no siempre traen impuesto, retenciones de Colombia ni cupones de Stripe)

-- Q9 · coherencia factura ↔ contrato y entre holdings
SELECT h.name, count(*) FILTER (WHERE cl.holding_id<>i.holding_id), count(*) FILTER (WHERE ce.holding_id<>i.holding_id),
  count(*) FILTER (WHERE co.holding_id<>i.holding_id), count(*) FILTER (WHERE c.id IS NOT NULL AND i.client_id IS DISTINCT FROM c.client_id),
  count(*) FILTER (WHERE c.id IS NOT NULL AND i.client_entity_id IS DISTINCT FROM c.client_entity_id),
  count(*) FILTER (WHERE c.id IS NOT NULL AND i.company_id IS DISTINCT FROM c.company_id), count(*) FILTER (WHERE i.client_id IS NULL)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id LEFT JOIN clients cl ON cl.id=i.client_id
LEFT JOIN client_entities ce ON ce.id=i.client_entity_id LEFT JOIN companies co ON co.id=i.company_id LEFT JOIN contracts c ON c.id=i.contract_id
WHERE i.is_active AND i.status<>'Cancelada' GROUP BY 1;
-- resultado: 0 facturas y 0 contratos con cliente, razón social o compañía de otro holding

-- Q9b · razón social de la factura no vinculada a su cliente
SELECT h.name, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status<>'Cancelada' AND i.client_entity_id IS NOT NULL AND i.client_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id=i.client_entity_id AND x.client_id=i.client_id)
  AND NOT EXISTS (SELECT 1 FROM client_entities e WHERE e.id=i.client_entity_id AND e.client_id=i.client_id) GROUP BY 1;

-- Q9c · compañías
SELECT h.name, co.legal_name, co.country_code, co.currency, co.tax_rate FROM companies co JOIN company_holdings h ON h.id=co.holding_id;

-- Q10 · forma del identificador tributario
SELECT h.name, coalesce(e.country_code,'??'), CASE WHEN coalesce(btrim(e.tax_id),'')='' THEN 'vacio'
  WHEN e.tax_id ~ '^cus_' THEN 'id de Stripe' WHEN e.tax_id ~ '^[A-Za-z]{2}' THEN 'letras' WHEN e.tax_id ~ '\s' THEN 'espacios'
  WHEN e.tax_id ~ '\.' THEN 'puntos' WHEN e.country_code='CL' AND e.tax_id !~ '^[0-9]{7,8}-[0-9Kk]$' THEN 'CL formato raro'
  WHEN e.country_code='CL' AND e.tax_id ~ 'k$' THEN 'k minuscula' ELSE 'ok' END, count(*)
FROM client_entities e JOIN company_holdings h ON h.id=e.holding_id GROUP BY 1,2,3;

-- Q11 · razones sociales con el mismo identificador normalizado  /  Q11b · clientes con el mismo nombre comercial
WITH n AS (SELECT e.*, upper(regexp_replace(e.tax_id,'[^0-9A-Za-z]','','g')) nt FROM client_entities e
  WHERE coalesce(btrim(e.tax_id),'')<>'' AND e.tax_id !~ '^cus_')
SELECT h.name, nt, count(*), count(DISTINCT lower(legal_name)), string_agg(DISTINCT coalesce(country_code,'?'),',')
FROM n JOIN company_holdings h ON h.id=n.holding_id GROUP BY 1,2 HAVING count(*)>1;
SELECT h.name, lower(regexp_replace(name_commercial,'[^0-9A-Za-zÁÉÍÓÚáéíóúÑñ]','','g')), count(*)
FROM clients c JOIN company_holdings h ON h.id=c.holding_id GROUP BY 1,2 HAVING count(*)>1;

-- Q12 · valores de industria/segmento/mercado fuera del catálogo (master_data)
SELECT h.name, x.cat, count(*), string_agg(DISTINCT x.v, '; ')
FROM (SELECT holding_id, 'industries' cat, industry v FROM clients UNION ALL SELECT holding_id, 'segments', segment FROM clients
      UNION ALL SELECT holding_id, 'markets', market FROM clients) x JOIN company_holdings h ON h.id=x.holding_id
WHERE coalesce(x.v,'')<>'' AND NOT EXISTS (SELECT 1 FROM master_data m WHERE m.holding_id=x.holding_id AND m.category=x.cat AND m.value=x.v)
GROUP BY 1,2;
SELECT value FROM master_data WHERE holding_id='5652e95e-bb99-48f5-aa1c-13c8c2638fc6' AND category='industries' ORDER BY lower(value);

-- Q12b · sin país  /  Q12c · texto de país que no calza con el nombre del ISO
SELECT h.name, count(*) FILTER (WHERE coalesce(c.country,'')='') , count(*) FILTER (WHERE coalesce(c.country,'')<>'' AND c.country_code IS NULL)
FROM clients c JOIN company_holdings h ON h.id=c.holding_id GROUP BY 1;   -- ídem client_entities
SELECT h.name, x.country, x.country_code, k.name_es, count(*)
FROM (SELECT holding_id, country, country_code FROM clients UNION ALL SELECT holding_id, country, country_code FROM client_entities) x
JOIN company_holdings h ON h.id=x.holding_id LEFT JOIN countries k ON k.code=x.country_code
WHERE coalesce(x.country,'')<>'' AND (k.code IS NULL OR (lower(translate(x.country,'áéíóúÁÉÍÓÚ','aeiouAEIOU'))
  NOT IN (lower(translate(k.name_es,'áéíóú','aeiou')), lower(k.name_en)) AND upper(x.country)<>x.country_code)) GROUP BY 1,2,3,4;

-- Q13 · emitidas sin número  /  Q13b · número repetido por compañía y documento
SELECT h.name, i.invoice_type, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status IN ('Emitida','Enviada','Pagada','Vencida') AND coalesce(btrim(i.invoice_number),'')='' GROUP BY 1,2;
SELECT h.name, count(*), sum(n) FROM (SELECT holding_id, company_id, document_type, invoice_number, count(*) n FROM invoices
  WHERE is_active AND status IN ('Emitida','Enviada','Pagada','Vencida') AND coalesce(btrim(invoice_number),'')<>'' AND invoice_type<>'Suscripción'
  GROUP BY 1,2,3,4 HAVING count(*)>1) d JOIN company_holdings h ON h.id=d.holding_id GROUP BY 1;

-- Q14 · notas de crédito: sin factura de origen, positivas, por estado
SELECT h.name, i.status, i.invoice_type, count(*), count(*) FILTER (WHERE i.related_invoice_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_references r WHERE r.invoice_id=i.id)), count(*) FILTER (WHERE i.amount_invoice_currency>0)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id WHERE i.is_active AND i.document_type='NC' GROUP BY 1,2,3;

-- Q15 · facturas Vencida con NC viva por el total
SELECT h.name, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status='Vencida' AND coalesce(i.document_type,'')<>'NC'
  AND EXISTS (SELECT 1 FROM invoices n WHERE n.related_invoice_id=i.id AND n.document_type='NC' AND n.is_active
    AND n.status<>'Cancelada' AND abs(n.amount_invoice_currency + i.amount_invoice_currency) < 1) GROUP BY 1;

-- Q16 · fechas de contrato  /  Q16b · ítems  /  Q16c · vencimiento antes de emisión
SELECT h.name,
  count(*) FILTER (WHERE c.churn_date > c.contract_end_date) baja_despues_fin,
  count(*) FILTER (WHERE c.status='Cancelado' AND c.churn_date IS NULL) cancelado_sin_baja,
  count(*) FILTER (WHERE c.status='Activo' AND c.churn_date <= current_date) activo_con_baja_pasada,
  count(*) FILTER (WHERE c.status='Activo' AND c.contract_end_date < current_date AND NOT EXISTS (SELECT 1 FROM contract_items x
    WHERE x.contract_id=c.id AND (x.end_date IS NULL OR x.end_date>=current_date))) activo_vencido,
  count(*) FILTER (WHERE c.contract_end_date IS DISTINCT FROM (SELECT CASE WHEN bool_or(end_date IS NULL) THEN NULL ELSE max(end_date) END
    FROM contract_items x WHERE x.contract_id=c.id)) fin_distinto_items
FROM contracts c JOIN company_holdings h ON h.id=c.holding_id WHERE c.deleted_at IS NULL GROUP BY 1;
SELECT h.name, count(*) FILTER (WHERE i.end_date < i.start_date), count(*) FILTER (WHERE i.churn_date < i.start_date)
FROM contract_items i JOIN contracts c ON c.id=i.contract_id AND c.deleted_at IS NULL JOIN company_holdings h ON h.id=c.holding_id GROUP BY 1;
SELECT h.name, count(*) FROM invoices i JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status<>'Cancelada' AND i.due_date < i.issue_date GROUP BY 1;

-- Q17 · frescura del devengo por contrato
WITH r AS (SELECT contract_id, max(updated_at) last_calc, bool_and(updated_at >= '2026-10-02 01:17:29+00') todo_v2,
             bool_or(updated_at >= '2026-10-02 01:17:29+00') algo_v2 FROM revenue_schedule_monthly WHERE contract_id IS NOT NULL GROUP BY 1),
ch AS (SELECT contract_id, max(t) last_change FROM (SELECT contract_id, changed_at t FROM contract_change_log
  UNION ALL SELECT contract_id, changed_at FROM contract_item_change_log UNION ALL SELECT contract_id, updated_at FROM quantities
  UNION ALL SELECT contract_id, updated_at FROM consumption_entries UNION ALL SELECT contract_id, sent_at FROM invoices WHERE sent_at IS NOT NULL) x
  WHERE contract_id IS NOT NULL GROUP BY 1)
SELECT h.name, count(*), count(*) FILTER (WHERE r.todo_v2), count(*) FILTER (WHERE r.algo_v2 AND NOT r.todo_v2),
  count(*) FILTER (WHERE NOT r.algo_v2), count(*) FILTER (WHERE ch.last_change > r.last_calc + interval '1 minute'),
  count(*) FILTER (WHERE NOT r.algo_v2 AND c.status='Activo')
FROM contracts c JOIN r ON r.contract_id=c.id JOIN company_holdings h ON h.id=c.holding_id LEFT JOIN ch ON ch.contract_id=c.id
WHERE c.deleted_at IS NULL GROUP BY 1;
SELECT asset_path, applied_at FROM sapira_sql_asset_history WHERE asset_path ~ '(revenue|rsm)' ORDER BY applied_at;

-- Q18 · monedas factura ↔ contrato  /  Q18b · contratos sin moneda de factura
SELECT h.name, count(*) FILTER (WHERE i.contract_currency IS DISTINCT FROM c.contract_currency),
  count(*) FILTER (WHERE c.invoice_currency IS NOT NULL AND i.invoice_currency IS DISTINCT FROM c.invoice_currency),
  count(*) FILTER (WHERE i.status='Por Emitir' AND c.invoice_currency IS NOT NULL AND i.invoice_currency IS DISTINCT FROM c.invoice_currency)
FROM invoices i JOIN contracts c ON c.id=i.contract_id AND c.deleted_at IS NULL JOIN company_holdings h ON h.id=i.holding_id
WHERE i.is_active AND i.status<>'Cancelada' GROUP BY 1;
SELECT h.name, count(*) FILTER (WHERE c.invoice_currency IS NULL) FROM contracts c JOIN company_holdings h ON h.id=c.holding_id
WHERE c.deleted_at IS NULL GROUP BY 1;

-- Q19 · Por Emitir atrasadas
SELECT h.name, i.invoice_type, count(*) FILTER (WHERE i.issue_date < current_date - 30), count(*) FILTER (WHERE i.issue_date < current_date - 180)
FROM invoices i JOIN company_holdings h ON h.id=i.holding_id WHERE i.is_active AND i.status='Por Emitir' GROUP BY 1,2;

-- Q20 · versiones de cálculo del RSM  /  Q21 · suscripciones vs RSM
SELECT h.name, r.calc_version, count(*), count(DISTINCT r.contract_id), count(DISTINCT r.subscription_id), min(r.updated_at), max(r.updated_at)
FROM revenue_schedule_monthly r JOIN company_holdings h ON h.id=r.holding_id GROUP BY 1,2;
SELECT s.status, count(*), sum(s.monthly_amount_system_currency), max(s.last_synced_at),
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM revenue_schedule_monthly r WHERE r.subscription_id=s.id))
FROM subscriptions s WHERE s.holding_id='5652e95e-bb99-48f5-aa1c-13c8c2638fc6' GROUP BY 1;
SELECT max(period_month) FROM revenue_schedule_monthly WHERE subscription_id IS NOT NULL;

-- Q22 · filas sin tasa
SELECT h.name, r.contract_currency, r.company_currency, count(*), count(DISTINCT r.contract_id), min(r.period_month), max(r.period_month)
FROM revenue_schedule_monthly r JOIN company_holdings h ON h.id=r.holding_id WHERE r.calc_version='missing_fx_rate' GROUP BY 1,2,3;

-- Q23 · usuarios por estado  /  Q23b · auth huérfano en ambos sentidos
SELECT h.name, u.status, count(*) FROM users u JOIN user_holdings uh ON uh.user_id=u.id JOIN company_holdings h ON h.id=uh.holding_id GROUP BY 1,2;
SELECT u.id, u.status FROM users u WHERE u.auth_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id=u.auth_id);
SELECT a.id, a.last_sign_in_at FROM auth.users a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.auth_id=a.id);

-- Q24 · facturas duplicadas (mismo contrato, fecha, monto, ítems y período)
WITH f AS (SELECT i.*, (SELECT string_agg(coalesce(ii.contract_item_id::text, ii.description)||'@'||coalesce(ii.billing_period_start::text,''), ',' ORDER BY 1)
  FROM invoice_items ii WHERE ii.invoice_id=i.id) k FROM invoices i
  WHERE i.is_active AND i.contract_id IS NOT NULL AND i.status<>'Cancelada' AND coalesce(i.document_type,'')<>'NC')
SELECT holding_id, contract_id, issue_date, round(amount_invoice_currency,2), k, count(*) FROM f GROUP BY 1,2,3,4,5 HAVING count(*)>1;

-- Q25 · MRR de meses completos vs monthly_price (ítems recurrentes sin consumo, misma moneda que el contrato)
WITH x AS (SELECT r.holding_id, r.contract_id, r.mrr_period_contract_ccy mrr, ci.monthly_price, r.updated_at >= '2026-10-02 01:17:29+00' v2
  FROM revenue_schedule_monthly r JOIN contract_items ci ON ci.id=r.contract_item_id JOIN contracts c ON c.id=r.contract_id AND c.deleted_at IS NULL
  WHERE NOT coalesce(r.is_total_row,false) AND ci.is_recurring AND ci.monthly_price IS NOT NULL AND ci.currency=c.contract_currency
    AND r.period_month > date_trunc('month', ci.start_date) AND (ci.end_date IS NULL OR r.period_month + interval '1 month' <= date_trunc('month', ci.end_date))
    AND (ci.churn_date IS NULL OR r.period_month + interval '1 month' <= ci.churn_date)
    AND NOT EXISTS (SELECT 1 FROM quantities q WHERE q.contract_item_id=ci.id) AND coalesce(ci.item_type,'') NOT ILIKE 'variable%')
SELECT holding_id, v2, count(*), count(*) FILTER (WHERE abs(coalesce(mrr,0)-monthly_price) > greatest(1, 0.01*abs(monthly_price))) FROM x GROUP BY 1,2;

-- Q26 · primer mes prorrateado vs monthly_price × días vivos / días del mes
WITH x AS (SELECT r.holding_id, ci.categoria, r.contract_id, r.recognized_period_contract_ccy rec,
    ci.monthly_price * ((date_trunc('month',ci.start_date)+interval '1 month')::date - ci.start_date)::numeric
      / extract(day from date_trunc('month',ci.start_date)+interval '1 month - 1 day') esperado,
    r.updated_at >= '2026-10-02 01:17:29+00' v2
  FROM revenue_schedule_monthly r JOIN contract_items ci ON ci.id=r.contract_item_id JOIN contracts c ON c.id=r.contract_id AND c.deleted_at IS NULL
  WHERE NOT coalesce(r.is_total_row,false) AND ci.is_recurring AND ci.monthly_price IS NOT NULL AND ci.currency=c.contract_currency
    AND r.period_month = date_trunc('month', ci.start_date) AND extract(day from ci.start_date) <> 1
    AND NOT EXISTS (SELECT 1 FROM quantities q WHERE q.contract_item_id=ci.id) AND coalesce(ci.item_type,'') NOT ILIKE 'variable%'
    AND (ci.end_date IS NULL OR ci.end_date >= (date_trunc('month',ci.start_date)+interval '1 month')::date))
SELECT holding_id, categoria, v2, count(*), count(*) FILTER (WHERE abs(coalesce(rec,0)-esperado) > greatest(1, 0.02*abs(esperado))) FROM x GROUP BY 1,2,3;

-- Q27 · MRR por mes SR: RSM (contratos / suscripciones) vs legacy y solapado U14
WITH rc AS (SELECT period_month m, sum(mrr_period_system_ccy) FILTER (WHERE contract_id IS NOT NULL) ctr,
              sum(mrr_period_system_ccy) FILTER (WHERE subscription_id IS NOT NULL) subs
            FROM revenue_schedule_monthly WHERE holding_id='5652e95e-bb99-48f5-aa1c-13c8c2638fc6' AND NOT coalesce(is_total_row,false) GROUP BY 1),
first_mrr AS (SELECT contract_id, min(period_month) fm FROM revenue_schedule_monthly WHERE coalesce(mrr_period_contract_ccy,0)<>0 AND contract_id IS NOT NULL GROUP BY 1),
lg AS (SELECT date_trunc('month',l.period_month)::date m, sum(l.mrr_legacy_system_currency) bruto,
         sum(l.mrr_legacy_system_currency) FILTER (WHERE l.migrated_to_contract_id IS NOT NULL AND l.period_month >= f.fm) solapado
       FROM mrr_legacy l LEFT JOIN first_mrr f ON f.contract_id=l.migrated_to_contract_id
       WHERE l.holding_id='5652e95e-bb99-48f5-aa1c-13c8c2638fc6' AND l.is_recurring GROUP BY 1)
SELECT coalesce(rc.m, lg.m), rc.ctr, rc.subs, lg.bruto, lg.solapado,
  coalesce(rc.ctr,0)+coalesce(rc.subs,0)+coalesce(lg.bruto,0), coalesce(rc.ctr,0)+coalesce(rc.subs,0)+coalesce(lg.bruto,0)-coalesce(lg.solapado,0)
FROM rc FULL JOIN lg ON lg.m=rc.m ORDER BY 1;
```

## 9. Lo que no se encontró (para no buscarlo de nuevo)

- Ningún contrato sin ítems; ningún ítem con producto o holding de otro holding.
- Ninguna factura ni contrato con cliente, razón social o compañía de otro holding.
- Ningún país con texto sin código ISO (el hallazgo anotado en §4 ya no aplica); ningún correo de usuario duplicado.
- Ningún número de cotización duplicado (solo 3 vacíos); el índice único sigue sin crearse en producción.
- Ningún ítem con fin anterior a su inicio; ningún contrato con fin anterior a su inicio.
- Ninguna fila RSM huérfana; ningún ítem Activo/Cancelado sin RSM.
- Facturas "duplicadas" por contrato + fecha + monto: casi todas son períodos distintos de la misma fecha (cobro de atrasos); con el
  período incluido queda 1 par (UP-9).
