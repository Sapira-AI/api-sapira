> ⚠️ **COPIA ESPEJO — convención de doble anotación (acordada Domi+Leon, 21-09).** Este backlog
> vive en DOS repos a la vez: `sapira-ai/docs/ROADMAP-OPERATIVO.md` (donde aterrizan los fixes urgentes del
> front viejo) y este archivo (porque la mayoría de estos fixes requieren cambios en la base, que
> se hacen desde `api-sapira`). **Todo cambio a uno se replica en el otro en la misma sesión** —
> mismo texto, mismo commit referenciado. Si divergen, manda el de `sapira-ai` y se re-sincroniza.
> Índice del plan v2: [`ROADMAP-V2.md`](../ROADMAP-V2.md).

# 🗺️ Roadmap de desarrollo Sapira — backlog unificado

> **Actualizado:** 2026-11-16 (bloque 6: rebaja con fecha anterior a lo emitido construida; P5 rebaja sobre ítem renovado) · 2026-11-13 (bloque "Pendientes del sistema nuevo": registro vivo desde el switch, con la regla de actualizarlo en cada tarea) · 2026-10-05 (premisa del borrado de funciones y edge function `rag-chat` muerta) · 2026-10-03 ("Resuelto en v2" suma Configuración y usuarios) · 2026-10-02 (bloque "Resuelto en v2" y regla de no arreglar lo que solo afecta al front actual) · antes 2026-08-31 (reclasificación de reportes de la semana: ⚡ Tanda 3, scheduler = regla de soporte, import → carril León, upsell desde cotización → Complejos #1, estratégico #25) · base 2026-08-24 (reestructura completa por estado + esfuerzo, revisión profunda de las 108 memorias + verificación en vivo contra código y BD prod/dev) · **Mantienen:** Domi + Leon
> Estructura: **✅ Desplegado y probado** · **🟡 Terminado, en validación de producción** · **🔴 Pendientes** ordenados de rápido a complejo (⚡ tandas rápidas → 🔨 medios → 🏗️ complejos) + **carril León (api-sapira)** · **🟣 Estratégico** (se trabaja en la versión nueva del sistema, no aquí).
> Convención: al cerrar un ítem, moverlo a "Desplegado" con commit/migración. Este doc es la fuente de verdad del orden; el detalle técnico vive en los docs/memorias referenciados.
> Todo ítem de esta versión fue **verificado contra el estado real** (código del repo, api-sapira y funciones vivas en Supabase prod) el 24-08 — no es solo consolidación de memorias.

## ✅ Desplegado y probado

| Qué | Referencia |
|---|---|
| **Venta puntual NO recurrente vía Upselling** — toggle Recurrente/No recurrente en el wizard del modal (misma semántica que cross-sell: fluye normal por plazo/frecuencia/devengo, solo no suma MRR; duración 1 mes → una factura por el total). + merge mensual filtra `is_active`/Unificada/Consolidada + mapeo fila→ítem por `source_key` | `2f6ab4f` (24-08); sin migraciones; validado SQL en Hanka dev |
| **FX del documento al unificar + barra de acciones masivas + Desunificar** — RPC acepta `p_fx_policy` spot/fixed + tasas por par, normaliza facturas origen, prefijo CTR con guion corto (SII) | `3a5d534`; migr `20260822103926`/`20260822105410` dev+prod paridad md5 |
| **Quick wins TiMining 24-08** — pago en cero→Pagada · calendario de facturas (productos, meses fijos, tooltip) · exportadores con fix raíz del "excel desactualizado" (corte 1000 + facturas ocultas) · scroll único Facturación · AR: calendario de ingresos por semana/quincena/mes | `0e7c2c7`; migr `20260824120000` dev+prod |
| **Ajuste de factura emitida a lo emitido** — `adjust_issued_invoice` + botón ámbar solo con descuadre (detector de diferencias) + `edit_pending_invoice` (reemplaza `edit_invoice_safe`, eliminada) | `bd3f322`/`d886831`; migr `20260729171350` + `20260729225325` dev+prod |
| **Editar ítems ↔ facturas (núcleo P1 #4)** — `sync_invoices_for_contract_item`: guardar ítems sincroniza Por Emitir (emitidas como ancla), bloqueos explicativos, motor Reestructurar blindado | `f439247`; migr `20260730100000`+`20260730110000` dev+prod; QA prod en curso (ver 🟡) |
| **Churn v2** — NC nace Emitida/clasificada/vinculada con signos correctos, prorrateo por días, TV recalculado, rebuild garantizado (7 bugs del flujo resueltos) | migr `20260727112906`, `de38299` |
| **Unificación NC completa + devengo** (modal único, motivos, impact_month/defer_forward, KPIs NC-aware) | `9d1a56d`→`9b45230`, migr `20260727*`; `docs/facturacion/notas-de-credito-diseno.md` |
| **Facturación unificada multi-contrato** (RPC + front completo + RSM billed multi-contrato) | `3565a78`+`cb3fc91`, migr `20260728*` |
| FX inverso desde subtotal neto exacto · FX fijo end-to-end (api fase 5) · overrides de cantidades (5 migraciones) · fix `is_active` en envío masivo · wizard de contrato (huérfanos + toggle facturas) · gestión usuarios A–J · downsell parcial RPC atómica · churn cancela cronograma · vencimiento editable en modal de fechas (`4c71ccb`) · dedup client_entities · consolidate/reschedule moneda | ver memorias respectivas; todo con commit + migración en prod |

---

## 🟡 Terminado, en validación de producción

| # | Qué | Qué falta validar | Caso de referencia |
|---|---|---|---|
| V1 | **Editar ítems ↔ facturas (P1 #4)** | QA dirigido con casos concretos de las usuarias (los reclamos de agosto eran con front viejo, el núcleo llegó a prod el 24-08) | Pedir: contrato + qué editaron + esperado vs ocurrido |
| V2 | **Regeneración que aplanaba líneas** | Verificar si el núcleo P1 #4 cerró el bug sistémico `1×monthly` en vez de `qty×unit` (reportado 22-06; barridos manuales de 35 y 79 líneas) | Chilexpress CTR-95 |
| V3 | **Cierre unificada (P0 #2)** | Test e2e real en prod con envío al ERP — confirma de paso los bugs de la 1ª unificación (línea inv-ccy NULL→$0, header, IVA) cubiertos por `20260822103926` + docs + Help Center | Nestlé CL 155+156, Brightcell |
| V4 | **Reestructurar con selector de modos** | Validación Domi + QA e2e caso Alicorp real | F101-00004292 (líneas 81.107 vs header 22.490 PEN) |
| V5 | **Venta puntual no recurrente** | QA visual Domi + llegar a prod | TEST-HANKA-UPSELL-01 (dev) |
| V6 | **Moneda del contrato en wizard** (Select lista ISO completa, contrato + ítems) | QA Domi + commit | SimpliRoute: quedaba fija en USD |
| V7 | **Tab Cuentas por Cobrar (AR v1)** + calendario de cobros | QA visual final | Cifras validadas vs SQL (TiMining 306K) |
| V8 | **Multiselect filtros en prod** | Validar 2 min en prod (`97e4039`); si falla, reabrir investigación | Solo fallaba en producción |
| V9 | **MRR legacy link/merge** + verificación de imports SF nuevos (sesión B junction) | Un caso real en prod y cerrar | `e90e224` |

---

## 🟢 Resuelto en v2 (front nuevo) — no se arregla en el front actual

> **Regla acordada (Domi, 02-10):** no se invierte tiempo en fixes que solo afectan al front actual. Lo que ya está
> resuelto en la versión nueva llega a las usuarias con el switch. Después del switch, tras un tiempo prudente de
> pruebas, se hace el drop y la limpieza de los triggers y funciones que ya no se usan. Estado completo del avance y
> plan del switch: `api-sapira/docs/v2-rediseno/estado-v2-y-plan-switch.md`.
> Marcado el 02-10 (y el 03-10 con Configuración) con lo construido en el laboratorio de `front-sapira`. **Resuelto** = construido y revisado por Domi
> en el lab; **Parcial** = cubierto en parte o por confirmar al revisar el módulo. Los ítems que no aparecen aquí no se
> evaluaron: siguen como están abajo.

| Ítem de este backlog | Estado en v2 | Dónde quedó |
|---|---|---|
| Alerta de duplicado al crear razón social + eliminar razón social sin referencias (15–16 sep) | ✅ Resuelto en v2 | Clientes: "Crear igual" si el identificador ya existe; Eliminar con verificación de uso (360 de la razón social y en lote) |
| Medios #1 · Fallos silenciosos → bloqueos explicativos (sin partner, producto sin mapeo, resultado del vínculo) | ✅ Resuelto en v2 | Contratos y Facturación: bloqueos con motivo y solución; el producto sin mapeo ya no se envía con producto por defecto (validar con Leon antes de desplegar). Clientes: "Vincular con ERP" muestra siempre el resultado |
| Carril León · Resolver el partner del ERP al crear razones sociales | ✅ Resuelto en v2 | Clientes: "Traer desde ERP" (la razón social nace vinculada) y búsqueda tolerante a puntos, guion y cero inicial |
| Medios #10 · Gestión de razones sociales desde su pestaña | ✅ Resuelto en v2 | Clientes: lista de razones sociales con alta, vista rápida, 360, asignar/desasignar cliente y acciones en lote |
| Medios #12 · Renegociación (cantidad + precio, frecuencia, plazo) | ✅ Resuelto en v2 | Contratos: "Modificar contrato" por intención |
| Medios #13 · Cambiar la razón social de un contrato activo, con historial | ✅ Resuelto en v2 | Contratos: Modificar facturación |
| Complejos #1 · Grupo Modificaciones (upsell/cross-sell/downsell, plazo, ciclo, clasificación, cotización → contrato) | ✅ Resuelto en v2 | Contratos: modificaciones v2 (`spec-modificaciones-contrato-v2.md`, `cobertura-contratos-v2.md`) |
| Complejos #3 · Guard raíz del trigger standardize | ✅ Resuelto de raíz en v2 | La API escribe los campos derivados y los triggers heredados no corren para ella (`sapira.writer = 'api'`); se eliminan después del switch |
| Complejos #7 · Vista previa antes de persistir | ✅ Resuelto en v2 | Contratos: "Lo que vas a hacer" y facturas afectadas como vista previa real |
| Complejos #8 · Propagación a los datos del contrato (fecha de término, total) | ✅ Resuelto en v2 | `contract_end_date` = término del último ítem vigente; la API recalcula los derivados |
| Complejos #9 · Pausa / reactivación | ✅ Resuelto en v2 (a nivel contrato) | Contratos: Pausar, Reanudar y Reactivar. Pausa solo de facturación: deseada, no construida |
| Tanda 3 #1 · Churn con fecha de registro en vez de la efectiva | ✅ Resuelto en v2 | `booking_date` solo para CMRR; devengo, facturación y MRR desde la fecha efectiva; baja prorrateada |
| Estratégico #25 · Contratos indefinidos + ajustes planificados | ✅ Resuelto en v2 | Ítem indefinido, pactos (cambios futuros, también en el alta) y propuestas de renovación |
| Medios #7 · Correlativo de contratos | 🟡 Parcial | Índice único en producción (migración `1790720000000`); confirmar el generador secuencial al revisar el alta |
| Medios #5 · Visibilidad del tipo de cambio | 🟡 Parcial | Multimoneda v2: par y tipo de cambio en vista previa y vista rápida. El backfill de facturas antiguas no se hizo |
| Medios #11 · Términos de pago por cliente / razón social | 🟡 Parcial | Condiciones de pago estructuradas en la razón social y en la cotización; confirmar el caso SAT MX |
| Medios #4 · Editar ítem de cotización no recalcula precios | 🟡 Parcial | Cotizaciones v2 recalcula y alinea el total al guardar; confirmar en la revisión del módulo |
| Complejos #5 · Descuento con tratamiento de NC | 🟡 Parcial | NC de descuento con tratamiento de devengo desde la factura; el caso "Por Emitir" por confirmar |
| Complejos #6 · Sesión RSM | 🟡 Parcial | Reglas aprobadas en v2 (mensual = precio mensual, baja prorrateada, sin tipo de cambio = vacío); falta el rebuild completo por holding, previo al switch |
| Complejos #4 · Matriz fiscal / tipo de documento | 🟡 Parcial | Documento tributario en el alta del contrato; la matriz por país sigue pendiente |
| Mensajes ilegibles (CFDI, import) | 🟡 Parcial | Errores del envío al ERP traducidos a lenguaje claro con la solución; los de importación siguen en el carril León |
| Estratégico #20 · Modelos de precio por tramos | 🟡 Parcial | Precios v2, primera versión; falta la segunda vuelta |
| Tanda 2 · Tax rate de compañías (pantalla Razones Sociales: decimal vs entero, "1900%") | ✅ Resuelto en v2 | Configuración: el impuesto vive en el documento tributario de cada compañía y la facturación lo toma de ahí. Quedan 2 compañías de Lenosoft con 0.19 por revisar en la auditoría de datos |
| Gestión de usuarios · invitación sin validar | ✅ Resuelto en v2 (sin commit al 03-10) | Configuración › Usuarios: invitar y reenviar desde la API, con validación y `/auth/confirm` + `/bienvenida` |
| Gestión de usuarios · desactivar usuarios (no existía) | ✅ Resuelto en v2 (sin commit al 03-10) | Desactivar/reactivar por holding (bloquea la cuenta en Auth si no le quedan holdings); eliminar solo invitaciones que nunca entraron |
| Correos de Supabase sin formato (invitación, recuperar contraseña) | ✅ Resuelto en v2 (sin commit al 03-10) | Correos propios por Resend desde `noreply@aisapira.com`, plantillas versionadas en api-sapira. Falta configurar Supabase Auth y variables de la API |
| Cierre de períodos que bloqueaba pagos | ✅ Resuelto en v2 | Compañía 360: el cierre solo bloquea contratos e ítems; pagos y cobranza siguen operando |
| Redirección abierta en el callback de auth | ✅ Resuelto en v2 (sin commit al 03-10) | `front-sapira` `app/auth/callback` solo acepta destinos internos |
| Medios #6 · Productos: recurrencia y gestión | 🟡 Parcial | Pestaña Productos en Precios (archivar en vez de eliminar); falta mostrar archivados en los selectores de Contratos, Cotizaciones y Precios |
| Documentación interna / Help Center | 🟡 Parcial (sin commit al 03-10) | Centro de ayuda `/ayuda` reemplaza `/documentacion`; al switch se abre a todos y se dan de baja HelpKit y Notion |
| Medios #9 Panel de vendedores · Complejos #10 Notificaciones | ⏳ Módulos por construir en v2 | Integraciones y Notificaciones (vendedores ya se administran en Configuración) |

---

## 🔴 Pendientes — de rápido a complejo

### 🔴 Pendientes del sistema nuevo (registro vivo desde el switch · actualizado 2026-11-16)

> **Regla (Domi, 13-11):** este bloque es el registro único de lo pendiente en el sistema nuevo (`api-sapira` + `front-sapira`).
> **Se actualiza en la misma tarea que cierra, cambia o agrega un punto**: lo cerrado baja a "Cerrado" con su commit y fecha, lo nuevo
> entra con su caso y el enlace a su detalle. Nada de aquí se construye sin plan por punto y OK de Domi. El detalle técnico vive en la
> nota enlazada de `docs/cambios/`. Este bloque se anota solo en `api-sapira`: no son pendientes del front anterior.
>
> Estado base 13-11: `domi` = `qa` = `main` en ambos repos (API v0.0.167, front v0.1.106); QA y producción sin migraciones pendientes.
>
> Estado 16-11: `qa` = `main` con API v0.0.168 (PR #269 y #270) y front v0.1.107 (PR #113 y #114): incluyen los bloques 8 y 9. En `domi`,
> **solo en local y sin push**, quedan los commits del bloque 6: en la API, los documentos del 13-11 (`b9d32b9`) y la rebaja con compensación; en el front, `8211f76`.

**1 · Ransa / SimpliRoute** · detalle: [`cambios/precio-unitario-del-periodo-13-11.md`](./cambios/precio-unitario-del-periodo-13-11.md)

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| R1 | **Migración de los 4 contratos de Ransa** (CTR-2026-412, CTR-2026-82, CTR-2026-82-CHILE, CTR-2026-Salvador) al precio unitario del período | Soporte, después del deploy | Registrar cantidad y unitario real por período. Decidir qué pasa con septiembre y octubre de CTR-2026-412, que ya están como borrador en el ERP a cantidad base. No se tocan datos de Ransa, CCU ni Camposur desde desarrollo |
| R2 | **B · Repartir una cotización entre varios contratos del mismo cliente** | Solo esquema | Plan por archivo y OK. Requiere migración (`quotes.salesforce_account_id`, `salesforce_account_country`) e importar cuenta y país desde el CRM |
| R3 | **C · Grupo de precio regional por tramos sobre varios contratos** | Solo esquema | Plan por archivo y OK. Requiere tablas nuevas (`price_groups`, `price_group_items`) con RLS |
| R4 | Lo que quedó fuera de A por decisión de Domi (13-11): modelo `per_period`, retención en el scheduler de facturas con consumo pendiente, cambio de la regla de MRR, bloqueo del unitario en Editar factura | No se hace | No reabrir sin pedido explícito |

**2 · Facturas unificadas (Brightcell)** · detalle: [`cambios/brightcell-unificadas-10-11.md`](./cambios/brightcell-unificadas-10-11.md) → "Pendiente: editar y reorganizar orígenes"

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| U1 | **Editar factura y Reorganizar sobre los orígenes de una unificada** (hoy el origen manda a la unificada y la unificada al origen) + "Editar en el origen" desde la vista rápida | Plan presentado 10/11-11 | OK de Domi. Caso: Brightcell octubre, CTR-2026-110 |
| U2 | **Marca "no unificar"**: una línea sacada de una unificada queda suelta Por Emitir el mismo mes sin que la regla de las 06:30 la reabsorba | Plan presentado | OK. **Cambio de esquema** (campo en `invoices`, checklist de la guía) |
| U3 | **4d** · Aviso de línea con tasa fija sin tasa en unificadas | Parcial (`fx_mixed_in_pair`, `pair_rates_differ` ya existen) | Aviso restante |
| U4 | **Neto de la orden de compra por línea** (hoy por moneda: `net_by_pair`) | Idea de Domi | Definir alcance |
| U5 | **Listas de Facturación y de los 360 de cliente y razón social** siguen mostrando los orígenes en "Todas" | Sin empezar | Módulos cerrados: requiere pedido explícito de Domi |
| U6 | Invariantes de unificadas en el conocimiento de soporte (`docs/agentes/`) | Sin empezar | Carpeta de la sesión de soporte: se coordina con ella |

**3 · Revisión de código del 28-10 y bugs analizados sin corrección** · detalle: [`cambios/revision-28-10-y-prorrateo-visible.md`](./cambios/revision-28-10-y-prorrateo-visible.md) → "Pendiente del review" · [`cambios/errores-emision-erp-28-10.md`](./cambios/errores-emision-erp-28-10.md) → "E · Pendiente"

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| C3 | Alertas de error del ERP no se agrupan cuando el texto del mensaje trae datos de la factura | Sin empezar | Agrupar por causa |
| C4 | Cuando el ERP avisa "emitida" por error y Sapira lo revierte, no devuelve la fecha de emisión ni los montos | Sin empezar | Revertirlos también |
| C5 | Upsell sobre un período prepagado ya emitido (anual o trimestral): puede salir con fecha pasada | Sin bug confirmado | Test |
| C6 | Downsell prorrateado con ajustes parciales en el mismo período: asume que todas las líneas cubren el período completo | Sin empezar | Calcular por línea con su solape de días |
| C7 | Período partido en dos facturas: el prorrateo solo toca la primera | Sin empezar | Cubrir la segunda |
| C8 | **Cambiar el modelo de precio desde el primer período** no rige desde ahí (caso CTR-2026-413 Arca EC, corregido por datos) | Análisis y propuesta listos | OK de Domi |
| C9 | Lista de "estados facturados" copiada en tres lugares | Sin empezar | Unificar |
| CE | Resumen del envío automático agrupado por causa + `edi_state` en el aviso del ERP (pedido a Leon) | Plan escrito | OK y respuesta de Leon |
| CX | Edición masiva sin documento tributario; `invoice-dte.ts` trata como exportación una factura nacional de un contrato 110 | Anotado el 02-11 | Definir si se aborda |

**4 · Datos en producción** (siempre con OK explícito de Domi y respaldo)

| # | Pendiente | Estado |
|---|---|---|
| D1 | 6 ajustes DOWNSELL del sistema anterior con `quantity × unit_price ≠ monthly_price` (CTR-2026-007, S07608, S06975, S01688, S06426, CTR-2025-001): propuesta `unit_price = monthly_price / quantity` | Pendiente de OK. Último recuento 02-11 |
| D2 | A10166 (México): Emitida en Sapira, sin timbre en el ERP | Verificado 13-11. Falta decidir si vuelve a borrador en Sapira o se corrige en el ERP |
| D3 | Folios repetidos (Perú y holding demo): errores de folio reales | Esperan respuesta de Domi |

**5 · Entorno**

| # | Pendiente | Estado |
|---|---|---|
| E1 | `NOTIFICATION_EMAILS_ENABLED=false` en la API de QA: el cron de QA manda resúmenes a los mismos holdings y choca con producción | De Domi (no está en el repo) |

**6 · Rebaja con fecha anterior a lo emitido: compensar en las próximas facturas** (pedido de soporte 13-11; caso SimpliRoute S07212, México, MXN) · detalle: [`cambios/baja-retroactiva-con-compensacion-16-11.md`](./cambios/baja-retroactiva-con-compensacion-16-11.md)

Construido el 16-11 en `domi`, **sin push ni deploy**: modo `issued_overcharge: compensate_next` en la rebaja y en la corrección de una baja ya registrada. La baja rige desde su fecha real y lo facturado de más cubre parte de los períodos siguientes: las próximas Por Emitir del mismo producto salen con **menos cantidad** (baja de cantidad) o **menor precio unitario** (baja de precio), **sin descuento**, sin líneas negativas y sin nota de crédito. Protección del ajuste ante cualquier cambio posterior, devengo y envío al ERP (la línea viaja como cualquier otra). Sin migración: una función de devengo por aplicar como asset en QA y producción. Un solo commit por repo (front `8211f76`): la primera versión del mismo día, con el ajuste como descuento, se descartó antes de subir y no quedó en el historial.

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| B6 | **Expresar el ajuste en cantidad o en precio unitario, no como descuento** (Domi 16-11: "no hay descuento": lo facturado de más cubre parte de los períodos siguientes). S07212: 61 − 14 × 3 = 19 × 627 = 11.913 | **Construido 16-11 con OK de Domi, commit local** | Nada: va con B1. Motor, Editar factura, Reorganizar, facturar por OC, devengo, envío al ERP, front, tests y docs. API 259 suites en verde |
| B1 | **Push, QA y deploy** del modo de compensación | Commit local 16-11, tests en verde | OK de Domi para push (antes, merge de `origin/qa`); aplicar `revenue_schedule_rebuild_contract_ccy.sql` en QA y, con OK, en producción (`nc_discount_revenue_adjustment.sql` ya no cambia). **La factura de diciembre de S07212 se emite sola el 01-12**: tiene que estar en producción antes |
| B2 | **Corregir S07212** (la baja de 1 pasa a 15, compensando 26.334 en diciembre) | Después del deploy | La hace la usuaria: Corregir un dato › la baja › 15 › compensar en las próximas facturas. Simulado en tests con las cifras reales |
| B3 | **Confirmar con Leon los decimales de cantidad del ERP** | Sin hacer | La línea que compensa viaja como cualquier otra (cantidad × precio, sin descuento): el envío no cambia. Con prorrateo por días la cantidad lleva hasta 4 decimales; si el ERP redondea a menos, esa línea diferiría en centavos. La línea que queda en 0 no viaja. Ya no hace falta probar un descuento alto en México. Nota en `v2-rediseno/cambios-integracion-para-leon.md` |
| B4 | Devengo de un mes **emitido con desvío** (línea editada a mano o consumo) ante una rebaja retroactiva: sigue siendo lo facturado de ese período | Límite conocido, sin casos | Solo si aparece un caso: restar en D2-c lo compensado de ese período |
| B5 | Compensación en productos **por consumo o con modelo de precio** | Fuera de alcance (bloquea con el paso siguiente) | Definir la regla si se pide |

**7 · Cierre del sistema anterior** (pedido de Domi 13-11: pasó un mes desde el switch)

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| L1 | **Eliminar funciones, triggers y demás objetos del sistema anterior** que se mantuvieron solo por el período de prueba, y dejar base de datos y repos sin restos que confundan en sesiones de desarrollo. Validar en detalle, objeto por objeto, que no se usa ni afecta nada antes de borrar | Sin empezar | Sesión especial, después de B1 y de actualizar estos documentos. Se relaciona con "Nuevos 05-10" de más abajo (premisa del borrado de funciones, edge function `rag-chat`) y con `reglas-desarrollo/logica-en-api-triggers.md` |
| L2 | **Documentar que el paso al sistema nuevo está aplicado al 100 %** | Sin empezar | Al cerrar L1 |

Orden acordado (Domi 13-11): sesión paralela de auto-renovación y pactos futuros (hecha) → B1 (construido 16-11, con B6) → actualizar documentos → sesión de L1 y L2.

**8 · Renovación automática y cambios programados** (SimpliRoute fin de año, 13-11) · detalle: [`cambios/renovacion-automatica-y-cambios-programados-13-11.md`](./cambios/renovacion-automatica-y-cambios-programados-13-11.md)

Construido el 13-11 (API y front) y en `qa` y `main` desde el 16-11 (API v0.0.168, front v0.1.107): renovación automática y cambios programados que se aplican solos, acciones masivas de la lista (programar cambio por contrato o por producto, renovación automática), filtros por renovación automática y por tipo de ítem, hitos en la línea de tiempo, resumen diario de renovaciones por compañía y reversión de un cambio programado aplicado.

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| P1 | **Prueba de punta a punta en QA** de los jobs (renovar solo, aplicar solo) y de la reversión (aplicar un cambio, emitir la factura, revertir) | Sin hacer | Hacerla antes de producción: es lo único de este bloque que anula facturas emitidas. Recordar que rige para todos los holdings |
| P2 | **Baja de un ítem ya renovado** durante sus últimos 30 días | Bloqueado hoy | Decidir si la baja deshace la renovación |
| P3 | **Reajuste de ítems con modelo de precio** (tramos, consumo) | Fuera de alcance | Definir si se ajusta la tarifa |
| P4 | Reversión: casos que hoy se bloquean (factura pagada, con documento electrónico, con consumo, período cerrado) | Por diseño | Solo si las usuarias lo piden |
| P5 | **Rebaja (downsell) sobre un ítem ya renovado** con facturas por emitir de la renovación: el cambio del ítem vigente **quita** las líneas de la renovación (el grupo del ítem incluye a su sucesor y la línea neta solo conserva la del ítem pedido) y la rebaja de la renovación parte un período después de su inicio (`nextPeriodStart` nunca devuelve el inicio del ítem). Encontrado el 16-11 al construir B1; reproducido con test, independiente del modo de compensación | **Error sin corregir** | Plan y OK de Domi. Propuesta: limitar la línea neta a las líneas hasta el fin del ítem pedido y, en el sucesor, partir en su inicio. Producción al 16-11 (solo lectura): 0 rebajas sobre ítems renovados desde el 13-11; 2 ítems renovados vigentes con facturas por emitir de su renovación (SOD-01 y CAR-01, 36 líneas cada uno) y 357 ítems con renovación automática encendida, que quedarán renovados 30 días antes de su fin. **Corregir antes de que corran las renovaciones de fin de año** |

**9 · Corregir el modelo de precio mal cargado** (SimpliRoute CTR-2026-425Bolivia, 13-11) · detalle: [`cambios/correccion-modelo-de-precio-13-11.md`](./cambios/correccion-modelo-de-precio-13-11.md)

Construido el 13-11 (API y front) y en `qa` y `main` desde el 16-11 (API v0.0.168, front v0.1.107): una Expansión sin ítem base ya se lista en "Cambiar el modelo de precio" y "Cambió cuándo se factura", y "Corregir un dato mal cargado" permite corregir el modelo de precio desde el inicio del ítem.

| # | Pendiente | Estado | Qué falta |
|---|---|---|---|
| M1 | **Aplicar la corrección en CTR-2026-425Bolivia** (a consumo, Vehículos, USD 19) | Después del deploy | La hace Carelis desde el front; simulación en solo lectura sin bloqueos |
| M2 | Corrección del modelo **con períodos ya emitidos** | Hoy se bloquea | Decidir si se reparte la diferencia entre las Por Emitir, como las correcciones de valor |

**Cerrado** (para no volver a listarlo)

| Qué | Cuándo y dónde |
|---|---|
| Ransa A · precio unitario del período en el modelo Estándar por consumo | 13-11 · API `71df13a`, front `633b055`, migración `1792520000000-ConsumptionUnitPrice` en QA y producción |
| Datos del interruptor de emisión automática (incluye CTR-2026-411) | Recuento 13-11: 0 Por Emitir sin ERP desalineadas. Quedan 2 borradores en el ERP (CTR-2026-131, S07866) que no se tocan |
| Migración `DteSimulations` de Leon en producción | Aplicada (aparece en el snapshot del 13-11) |
| Stanhome: cambiar solo el modo de cobro; reemisión con emisión apagada | 10-11 · `37db916`, `f2568c5` |
| Brightcell 1–10 (unificadas: tasa por línea, cambios de contrato, rehacer, proforma, listas del contrato, cotización por línea, corregir fecha) | 10/11-11 · `cd0a164`, `47597e6` |
| Exportación MX/PE por documento tributario + correlativo sin duplicados por mayúsculas | 02-11 · `2a0f518`, `ae10299` |

### ⚡ Tanda 1 — Fixes SQL de facturación · ✅ DESPLEGADA 28-08 (dev+prod, paridad md5)

Migración `20260828120318_tanda1_fixes_facturacion` (reemplazo quirúrgico con anclajes verificados), 4 fixes testeados en Hanka dev con transacción+rollback:
1. **Churn con ítem $0** (`apply_contract_contraction`): los ítems con mensual 0 ya no bloquean — en CHURN se marcan churneados directo (el auto-cancel del contrato funciona; test: contrato quedó Cancelado con ambos ítems churneados), en DOWNSELL se saltan. Caso Porvenir CTR-2026-147 resuelto de raíz.
2. **Guard de cantidades vs Canceladas**: las facturas Canceladas dejan de bloquear el override → flujo NC→corregir cantidades→refacturar sin apagar triggers.
3. **Líneas con cantidad/precio/descuento reales** (`sync_invoices_for_contract_item`): fin del `1×monto` colapsado — test NSAgro-class: `17 × 1,33 = 22,61`. Cumple la regla "precio y descuento explícitos".
4. **Convención multimoneda al generar** (`generate_missing_invoices_for_contract`): contrato que factura en otra moneda → header Y líneas nacen con fx/montos inv-ccy NULL (incluye limpieza post-standardize); misma moneda sigue fx=1. Corta de raíz la familia "líneas convertidas con fx=1".
- 📌 **Export type en propagadores — REEMPLAZADO por decisión Domi 28-08**: la solución correcta es el **selector de tipo de documento en el front** (al crear contrato y en la tab Facturas de contratos activos) — vive dentro de la matriz fiscal (Complejos #4) como su primera entrega de UX.

### 🔴 Nuevos de la semana 25–28 ago (SimpliRoute)

- ✅ **Unificadas con FX SIEMPRE definido (Opción A, elegida por Domi) — DESPLEGADA 28-08 dev+prod** (migr `20260828125359`, paridad md5 `541fc129`): el modo Spot ya no deja el documento a medias — valoriza las líneas con la **tasa del día por par** (el modal la envía; fallback `exchange_rates`; sin tasa → bloqueo explicativo) y recalcula headers como Σ líneas. **Guard duro**: ninguna unificada puede crearse con líneas convertidoras sin valorizar (aplica también a llamadas sin política). Front: el modal envía las tasas del día también en spot y avisa si falta la de un par. Testeado en dev con el caso Reutter exacto (CLF+USD→CLP spot: neto 495.000 correcto, 0 líneas NULL; guard rechaza sin tasas). Evolución futura (con León): resolver spot al momento del ENVÍO en el api. Casos Reutter CTR-2026-173 y Nestlé 678c1b7e ya corregidos a mano en data.
- **Consolidar en el documento las líneas de mismo servicio+precio** (Carelis 26-08): solo en la factura que sale al cliente (Odoo); en Sapira se mantienen separadas por trazabilidad. Emparenta con "netear downsell en una línea". → capa de emisión (**carril León**).
- **One-shot facturado en cada período** (Alicorp CTR-2026-55): ⏸️ **en pausa por decisión Domi 28-08** — probablemente error de la usuaria; aclarar el caso antes de tocar semántica.
- **Mensajes del Centro de Notificaciones ilegibles** (CFDI40147): traducir códigos PAC/SAT a lenguaje de usuaria con pasos accionables. → **sesión aparte del repo api (León avisado)**.

### 🔴 Nuevos 15–16 sep (Carelis, casos Ransa SV / La Artesa / CTR-2026-86)

- ✅ **Ítem madre: cantidad vigente = SUMA de vigentes iniciados** (regla Domi: los ajustes llevan la diferencia; DOWNSELL resta, ítems con inicio futuro no cuentan hasta su fecha) — fix aplicado en `ContractItemsSummary` 16-09, pendiente commit+deploy. Caso CTR-2026-86 FORCEFIELD (mostraba 105 en vez de 130).
- ✅ **Rama renegociación alineada con la fórmula unificada del delta** (migr `20260916120000`, dev+prod, 4 tests exactos + regresión clásica): delta = diferencia en la dimensión que cambia, ancla en la que no, p×q = ΔMRR siempre; fórmula escrita en `docs/contratos/item-madre-y-renegociacion-casuisticas.md`. + **"Renegociación" como entrada propia del menú Modificar Contrato** (al nivel de Upselling/Down-selling; abre ContractionModal en modo renegociación, momentum automático por signo) y AssignToContract acepta renegociación también en ítems categoría Upsell. Pendiente commit+deploy front.
- **Alerta de duplicado al crear razón social** (mismo tax_id ya existe → avisar en vez de crear silencioso) + **eliminar razón social sin referencias desde el front** (hoy solo BD). Pedido Carelis 15-09 tras el duplicado Ransa SV.
- **Opción "Agrupación de facturas" (juntas/por ítem) también en Asignar cotización a contrato**: hoy solo existe en el wizard de crear contrato (`ProgramacionFacturacionSeccion`); al asignar una OPO multi-servicio genera 1 factura por servicio sin opción. Pedido Carelis 15-09 (preview 24 facturas, no aplicó).
- **Generador debe incluir la cuenta en la descripción de línea** cuando `contract_items.account` existe (formato "PRODUCTO Cuenta X - Periodo ..."): casos Alicorp y Ransa SV corregidos a mano. Emparenta con Tanda 3 #2 (sync pierde la cuenta al regenerar).
- **Self-service de exportación**: que la usuaria pueda marcar una razón social extranjera como "exportación exenta" y las facturas nazcan FCXE/tax 0 solas — es la cara visible de la matriz fiscal (complejos #4); mientras tanto lo configuramos nosotros por BD.

### 🔴 Nuevos 21-09 (revisión del front nuevo en producción, Domi con usuario SimpliRoute)

- ✅ **Documentación interna solo super admin** (front-sapira `ce38839` + sapira-ai `07cf64d`, pendiente PR/deploy): concepto de **permisos INTERNOS** (VIEW_DOCUMENTACION) que el comodín ALL_PERMISSIONS de roles de cliente NO destapa — entra super admin u otorgamiento explícito; gate por layout en `/documentacion` (estaba abierta a cualquier autenticado por URL directa); la UI de roles oculta los internos a no-super-admins (un admin de cliente con EDIT_CONFIGURACION podía auto-otorgarse cualquier permiso listado). ⚠️ Avisar a León: su seed pendiente `002-view-documentacion-permission.sql` otorga el permiso a todo rol con VIEW_REPORTES/VIEW_CONFIGURACION — recortarlo a solo crear el código.
- ✅ **Reporte de integración Odoo acotado por holdings del usuario** (api-sapira `fc48879`, pendiente PR/deploy): `GET /invoices/scheduler/report` devolvía TODAS las ejecuciones a cualquier autenticado; ahora no-super-admin ve solo sus holdings (corridas "all" excluidas por contener facturas de otros clientes).
- ✅ **Sidebar del front nuevo: Mi Perfil + holding del usuario** (front-sapira `ce38839`): modal Mi Perfil igual al front viejo, y la tarjeta/menú muestran el holding del usuario aunque no sea super admin (antes "Sin holding seleccionado").
- Pendiente de decisión: revisar si el resto de módulos del front nuevo necesita el mismo barrido de "diseñado para super admin" (selector de holding, otros reportes).
- 💡 **Idea para más adelante (Domi 21-09): foto de perfil / avatar de usuario** — hoy el perfil muestra iniciales; permitir subir una foto (o elegir un avatar) que se use en la tarjeta del sidebar, el menú y el modal Mi Perfil de ambos fronts. No es para ahora.
- ✅ **Reestructurar desbloqueado como auto-servicio (casos Fernanda 17/18-09, aplicado QA+prod 21-09 vía régimen nuevo de api-sapira)** — dos fixes en assets: (1) `check_contract_item_continuity` valida con overrides de Cantidades Variables (misma fórmula del header del front / fix Turboboy `04b7c44` que había quedado solo en front) — destapaba Farmacias Eos CTR-2026-218 (delta −588,51) y STG CTR-2026-38 (delta +3.554,56), verificado delta 0 contra los ítems reales; (2) `invoice_reschedule_items` ya no aplana las líneas a `1 × total`: escribe `cantidad del ítem × (subtotal ÷ cantidad)` en los 3 caminos (update, mover, insert post-standardize) — era el origen del `1×1.000` de CEFA S08540 y habría colapsado el 140×16 de STG al separar. Test e2e en QA (3 caminos + regresión + caso roto sigue detectando). ⏳ Pendiente: validación Fernanda → commit de los 2 assets en api-sapira rama domi. Data CEFA reparada por MCP (5 líneas a 25×40, residuo del bug ya corregido). 🔍 Para sesión de cuadre: barrido de líneas `1 × total` residuales en otros contratos reestructurados históricamente (detectables como `ii.quantity=1` con `ci.quantity>1` en PEs; ojo con falsos positivos de ítems por monto).

### 🔴 Nuevos 05-10 (merge de `qa` en `api-sapira`, revisión del borrado de funciones)

- **Corregir la premisa del borrado de funciones.** La migración `1791400000000-RetiraFuncionesSinUso` (62 funciones, 64 firmas, aplicada en prod el 04-10) se justifica en que *"el front viejo quedó bloqueado el 04-10 y no hay vuelta atrás a él"*. **Eso no es así:** está congelado pero sigue en uso hasta que el front nuevo cubra toda su funcionalidad (Leon, 05-10). Esta vez no rompió nada —los cuatro llamadores que quedaban (`rsm_metrics`, `convert_amount`, `rag_match_documents`, `get_user_holding_data_robust`) viven en la edge function `rag-chat`, que está retirada: el front viejo ya usa `POST /sapira-copilot/chat`—, pero la verificación enumeró **solo tres** edge functions por nombre (`check-overdue-invoices`, `send-proforma`, `send-collection`) y `rag-chat` no estaba en la lista. Corregir la justificación en `api-sapira/docs/v2-rediseno/catalogo-funciones-y-triggers.md` para que el próximo borrado no se apoye en una premisa falsa, y agregar "barrer **todas** las edge functions con fuente" al procedimiento.
- **Borrar la edge function muerta `rag-chat`** (`front-sapira-vite/supabase/functions/rag-chat/`). El front viejo ya no la invoca. Su código mantiene llamadas `.rpc()` a cuatro funciones que ya no existen en producción, y es exactamente lo que confundió la revisión del punto anterior. Mientras siga en el repo, cualquier barrido de "quién llama a esta función" va a dar falsos positivos.

### ⚡ Tanda 3 — Fixes SQL semana 29–31 ago · PRÓXIMA (antes que la Tanda 2: corrompe data activamente)

1. **Churn usa la fecha de registro (booking) en vez de la efectiva**: `contracts.churn_date` y el corte del prorrateo de la última factura deben salir del `start_date` del ítem CHURN, nunca de la fecha en que la usuaria lo registró. Caso CTR-2026-132 La Mascota (facturaba 5 días de agosto que no correspondían; data corregida a mano 31-08). Cada churn nuevo vuelve a reproducirlo. El diagnóstico de otros casos afectados (detección en la ficha `feature_bug_churn_prorrateo_booking_vs_start`) va a sesión de cuadre, no aquí. 📎 familia de `feature_bug_amendment_periodos_downsell` y PEN-01 TiMining.
2. **Regenerar facturas pierde el nombre de cuenta**: al editar ítems, las descripciones se reescriben solo con el producto e ignoran `contract_items.account` (caso CI: pisó incluso texto que Carelis escribió a mano en Odoo). Va en `sync_invoices_for_contract_item` — la misma función del fix 3 de la Tanda 1.

### ⚡ Tanda 2 — Fixes front rápidos (1 sesión)

| Fix | Problema verificado (24-08) | Caso |
|---|---|---|
| **Tax rate de compañías (pantalla Razones Sociales)** | `razonesSocialesService.ts` + `useRazonesSociales.ts` asumen decimal (`>1 ? /100`, default `0.21`) sobre `companies.tax_rate` que es entero (19) → el primer guardado corrompe el IVA (UI mostraría "1900%"). Prod aún intacto — bomba latente | `GeneralInfoTab.tsx` también; `EmpresaSettings` ya se corrigió (`95146d0`) |
| **Filtro "próximos a vencer" por ítem** | El filtro evalúa la fecha fin del contrato (prioriza `contract_end_date`); debe considerar el vencimiento del ítem/renovación más próxima (los datos ya se cargan en `useContratosFetch`) | TiMining 29-07: renovaciones parciales invisibles |
| **Redondeo del cronograma** | El front inserta floats del JSON en `contract_invoices.amount` → **1.335 filas sucias en prod, 273 desde julio** (sigue activo). `ROUND(...,2)` al insertar + limpieza | `11.899999999999999` |
| **Display FX en modal de factura** | `InvoiceViewModal` muestra "Tipo Cambio: 1" cuando la política es spot (engañoso); debe decir "Spot (se calcula al emitir)" vs "Fijo: tasa". La plomería del hook ya copia los campos FX (verificado) | Parte visible del pendiente FX fijo |

### 🔨 Medios (una sesión cada uno, orden por valor para la marcha blanca)

| # | Qué | Problema verificado (24-08) | Caso |
|---|---|---|---|
| 1 | **Fallos silenciosos → bloqueos explicativos** | Factura de entidad sin `odoo_partner_id` o con ítem sin `product_id`: el envío no ocurre y nada lo dice. Mensaje accionable en 3 lugares (detalle factura, envío masivo, alertas del contrato). El mensaje del caso sin partner debe indicar el **camino self-service ya activo** (dev León): cliente comercial → Razones Sociales → Editar → modificar la dirección (basta un punto) → al guardar se vincula sola con Odoo. Incluir también pre-chequeo ANTES de enviar a Odoo: producto sin mapeo en `odoo_product_mappings` o config fiscal incoherente (ej. `export_type=1` con país emisor = receptor) → avisar / no enviar Hallazgo 15-09 del self-service de vinculación: `RazonSocialFormModal` llama a `/odoo-partners/resolve-partner-by-tax-id` al guardar pero **se traga el resultado cuando no vincula** (`not_found`/`ambiguous` → solo `console.warn`; el usuario ve el toast de éxito de la edición y cree que funcionó) — mostrar SIEMPRE el resultado del resolve con su mensaje (ej. "existen 2 razones sociales con este RUT"); y `ClientEntityFormModal` (el otro modal de edición de razón social) no dispara el resolve en absoluto — unificar | TOMPETROL, SENAPRED, CTR-2026-184 Grupo Dalvi. Pedido Domi 11-08, reiterado 15-09 (Ransa SV sin partner; La Artesa CTR-2026-210 export local) |
| 2 | **Override de cantidad 0 → anular la factura** | La función de sync no maneja qty=0 (CHECK `quantity>0` + excepción silenciada): el RSM aplica 0 pero la factura queda viva → descuadre y riesgo de cobrar de más. Decisión de producto tomada (16-06): anularla, no mandarla en cero; y reactivarla si se elimina el override | CTR-2026-185 SG Comercial (abril/mayo quedaron como caso de prueba) |
| 3 | **Banner "hay versión nueva, actualiza"** | Al desplegar, los usuarios quedan con el build viejo hasta hacer hard-refresh manual (hoy se pide por Slack). Detectar build nuevo → banner con botón que recarga | Sacado del paraguas de notificaciones para no depender del sistema grande |
| 4 | **Editar ítem de cotización no recalcula precios** | `price`/`final_price` solo se calculan en el import SF; al corregir a mano una cotización importada con 0 no se recalculan → la validación `final_price > 0` bloquea Enviada→Firmada | NSAgro, Sinba |
| 5 | **FX fijo — resto de visibilidad** | Columna/badge de FX y política en la tab de facturas + backfill de ~61 facturas spot con FX pegado de antes del fix | El hook ya copia los campos (verificado); falta la UI y el backfill |
| 6 | **Productos: recurrencia y gestión** | Reportes de MRR incluyen productos no recurrentes; el CRUD no permite desactivar (`is_active`) ni bloquea eliminar-en-uso con mensaje claro | Pedido usuaria 18-06 |
| 7 | **Correlativo de contratos** | `formatContractNumber(prefix, contractId)` usa el hex del UUID → CTR-2026-8413FA contamina el correlativo (salieron 8414/8415). Generar secuencial con regex anclada `^CTR-2026-(\d+)$` | Sesión cuadre 21-07 |
| 8 | **Validación de excesos al reconciliar** | El front permite asignar a una factura un monto muy superior al real, sin validación `asignado ≤ factura` | Arquimed: $871.843 vs $316.734 |
| 9 | **Panel de vendedores** | Métricas del detalle no hacen sentido; falta funnel cotización→contrato→facturas + link directo al contrato | SimpliRoute 28-07; cero commits desde entonces |
| 10 | **Gestión de razones sociales desde su tab** | La gestión completa solo existe vía Clientes comerciales (⚠️ resolver antes el tax_rate de la Tanda 2) | TiMining 29-07 |
| 11 | **Términos de pago por cliente/razón social** (medio-alto) | Los términos son texto libre que no calcula nada; `contracts` no tiene la columna (verificado) → el dato se pierde al convertir la cotización. Incluye el caso SAT MX: `due_date = emisión + 30 días` hardcodeado en el generador (verificado) cuando PPD exige mes siguiente → 13 facturas rechazadas el 01-08. Mapeo término→días + propagación cotización→contrato→factura | TiMining (15/30/60 por cliente); MX SAT |
| 12 | **Renegociación de ítem: cantidad + precio a la vez (rama mixta del downsell)** — ✅ DESARROLLADA 13-09 (commit `c1b883b`): RPC con rama renegociación validada en dev (T1 mixto, T2 mensual→anual, errores, regresión) y aplicada dev+prod; modales Contraction/AssignToContract con modo "Renegociación"; + fix activación MRR legacy (qty=Σ líneas). Pendiente: QA UI con caso real + paso a qa/main | `apply_quote_downsell_to_contract` solo soporta rama cantidad O rama precio, y exige mensual menor (un cambio mixto puede subir el mensual → hoy irrepresentable). Diseño: spec con `new_quantity`+`new_unit_price` → **frontera de lo facturado**: cierra el ítem original al fin del último período emitido (final = lo facturado real), crea ítem nuevo (`renews_item_id`) con qty/precio nuevos hasta el fin original; PE futuras re-apuntadas con valores nuevos (`_recalc_invoice_header_from_items`), emitidas post-frontera vía NC + refactura (maquinaria existente). Validaciones explicativas: fecha efectiva = inicio de ciclo (v1 sin prorrateo), ítem con overrides en `quantities` → derivar a Cantidades Variables, sin-cambio → error. Evento lifecycle con delta CON SIGNO (si sube es upsell económico, el waterfall lo necesita). Front: tercer modo "Cantidad y precio" en DownSellingModal con preview mensual actual→nuevo. **Scope 13-09 (Domi): UNA sola iteración cubre ambos casos reales** — (a) qty+precio dentro del término (STG) y (b) renegociación con **cambio de frecuencia (mensual→anual) y término nuevo** (Moving Food): el spec acepta además `new_billing_frequency` y `new_end_date`; si el término nuevo excede el original, el ítem nuevo extiende `contract_end_date` (renovación anticipada renegociada) y el generador emite según la frecuencia nueva (1 PE anual). QA: regresión ramas actuales (fixes 04-09), mixto con/sin emitida en rango, descuento %, replay STG y High Power en dev | STG-Prosegur CTR-2026-38 (160×13,68→140×16, corregido a mano 11-09); High Power S07273; Moving Food S07230 (9×1,21 mensual → 9×1,1 anual, OPO `006RO00000enIBFYA2`); pedido explícito Carelis 11-09 ("solicité renegociación en su momento") |

| 13 | **Cambiar la razón social de un contrato activo desde el front (con historial)** | Hoy `contracts.client_entity_id` solo se cambia por BD; si al cliente le cambia la razón social receptora post-activación (caso real: Ransa Perú → habilitan facturar El Salvador), la usuaria puede reasignar las PE una a una pero el contrato queda apuntando a la entidad vieja. Diseño: acción "Cambiar razón social" en el contrato que actualice `client_entity_id` + PEs pendientes y registre el cambio en el Historial (lifecycle event). Evaluar impacto RSM/devengo — Domi (15-09) estima que no es complejo porque RSM cuelga del contrato/ítems, no de la entidad | Ransa El Salvador CTR-2026-Salvador (Carelis 14-09; swap hecho a mano en BD 15-09) |

### 🔨 Carril León (api-sapira — coordinar con él, no bloquean las sesiones de arriba)

| Qué | Estado verificado (24-08) |
|---|---|
| **Dedup del import legacy (guard permanente)** | `classifySingleInvoice` solo cruza contra `invoices_legacy`, nunca contra las facturas vivas (`invoices.odoo_invoice_id`) → si se re-corre el import completo, los duplicados vuelven (jun: 394; jul: 386, mitigados a mano) |
| **Validar y cerrar: emisión fallida con folio de borrador** | Aparentemente corregido: el webhook ya exige `state='posted'` antes de escribir folio y el scheduler registra `odoo_post_failed`. Validar con un caso y auditar las 45 facturas "Enviada" históricas posteadas en Odoo (data → onboarding) |
| **Validar y cerrar: productos fantasma desde SF** | Sin recurrencia desde el 09-07 (1 solo fantasma post-reporte, cero en 45 días) — confirmar fix con León y limpiar el fantasma restante |
| **Resolver `odoo_partner_id` al crear entities** | Al importar cotizaciones/crear entidades nuevas, cruzar contra Odoo por RUT normalizado y setear el partner (hoy fix manual por BD) — complementa el ítem 1 de medios |
| **Reporte tasas FX** | Guard "tasa >2 días vieja → no emitir + alerta" + snapshot `fx_policy_at_send` (paquete del incidente UF de julio, ya reportado) |
| **Notificaciones** | Infraestructura en curso (tabla `app_notifications` + suscripciones operacionales ya en prod) — ver C-Notificaciones abajo |
| **Mensajes de import ilegibles** | Import de clientes/facturas revienta con `invalid input syntax for type uuid` cuando el partner no existe (Terra Madre 31-08) → debe decir "el cliente X no existe" con paso accionable. Mismo catálogo de mensajes accionables que el ítem CFDI40147 (28-08) |

### 🏗️ Complejos (multi-sesión / diseño; orden por dolor actual de usuarias)

| # | Qué | Problema verificado (24-08) | Caso |
|---|---|---|---|
| 1 | **Grupo Modificaciones** (absorbe como etapas 1-2 los ex-medios de amendments) | Etapa 1: moneda de facturación ignorada en upsell/cross-sell inline (usa la moneda del ítem de cotización, verificado) + term del upsell no acotado al fin del contrato + `requested_by` y advertencia de duplicados + períodos solapados. Etapa 2: puertas laterales (merge AssignToContract sin filtrar unificadas — verificado línea 709 —, `change_contract_currency` antes de persistir, mover fechas masivo no reprograma, código muerto). Etapas siguientes: downsell TOTAL desde cotización (RPC lo rechaza), refactor AssignToContract a RPC atómica, decidir si `approve_contract_amendment` se retira o se blinda (sigue viva insertando sin protección, verificado) Evidencia nueva 31-08 (5 casos, flujo "aplicar upsell desde cotización"): toma el término de la cotización sin contrastarlo con el del contrato; actualiza `term` pero no la fecha de fin (quedan inconsistentes); etiqueta UPSELL productos que no existían en el contrato — debería ser CROSS-SELL (afecta el CMRR waterfall; candidato a adelantar solo si el reporte empieza a doler); cuotas nuevas nacen con vencimiento = emisión en MX (viola la regla +1 mes — conecta con Medios #11) | S04191 Central Exchange (sobrecobro ≈153 PEN + 6 facturas 2027 espurias), S02656, NSAgro, Sinba/Vend + 5 casos upsell-desde-cotización 31-08 |
| 2 | **Ítems variables con factura emitida** (baja a MEDIO si se elige "gate selectivo") | `sync_invoices_for_contract_item` bloquea TODA edición si el ítem tiene cantidades reales registradas. Opciones: (a) gate selectivo — permitir ediciones que no tocan precio/cantidad (quirúrgico); (b) sync parcial por período (complejo). **Espera decisión Domi** | Pedido SimpliRoute; learnings cierre Perú |
| 3 | **Guard raíz del trigger standardize** | El trigger pisa montos intencionales de 3 funciones vivas (contraction NC, `emit_invoice_manually` split, `approve_contract_amendment`) — migrarlas al patrón defer-FK probado y recién entonces evaluar el guard por columna (el generador DEPENDE del trigger — no es trivial) | Análisis completo: `docs/facturacion/standardize-trigger-analisis-casuisticas.md` |
| 4 | **Matriz fiscal por país/compañía/tipo de documento** | 4 piezas del mismo hueco (verificado: no existe `get_effective_tax_rate` ni tabla de tipos): el sistema no detecta exportación al generar; el api decide exportación por `export_type` mientras el front muestra `document_type` (dos fuentes de verdad); solo Perú asigna tipo de documento automático; no se puede elegir el tipo al crear contrato (P2 #9 histórico). **Recurrencia 14-09**: contrato NUEVO (La Artesa CTR-2026-210, CO local) nació con TODAS sus PEs en `export_type=1` → 3 de 4 borradores llegaron a Odoo sin impuestos (identificar qué ruta de creación sigue hardcodeando 1; el fix de `generate_missing` de junio no la cubre) | TiMining: 26 facturas PAGADAS (~USD 2M) con IVA que no correspondía; La Artesa CTR-2026-210 (14-09) |
| 5 | **Descuento en factura Por Emitir con tratamiento NC** | No hay forma de aplicar un descuento puntual (ej. pronto pago) que rebaje revenue como NC sin emitir primero. **Diseño → OK Domi → etapas** (orden 03-08) | Contratos uPlanner del ejercicio de devengo |
| 6 | **Sesión RSM dedicada** | 5 frentes de la función core + cierre operativo: sub-bugs B/C (ítems negativos no devengan; prorrateo último mes), **6 funciones con md5 dev≠prod (re-verificado 24-08: intactas desde julio)**, filas momentum duplicadas por (ítem,mes), el rebuild pisa overrides de períodos enviados, categoría inválida `RECURRENT` viva + trigger que la origina; al final, rebuild masivo de los 13 contratos TiMining pendientes | CHI-01/BAM-01/ANG-01/COD-01 descuadrados; uPlanner 19 pares duplicados; Ransa-82 |
| 7 | **Preview antes de persistir (iteración 2 editar ítems)** | Hoy guarda el ítem primero y sincroniza después: si la validación falla, el ítem quedó guardado con facturas viejas + error, sin poder arrepentirse. Rediseño: resumen "así quedará" ANTES de guardar + modo Cantidades en Reestructurar | Limitación v1 consciente del núcleo |
| 8 | **Propagación a headers del contrato** | `contract_end_date` nunca se actualiza al editar ítems, `total_value` solo desde el front, vencimientos no recalculan en RPCs — requiere diseño por choque con cierre de períodos (incluye decidir la regla del trigger `prevent_end_date_update_when_active`) | Sesión E del lote de junio, nunca iniciada |
| 9 | **Pausa/reactivación por ítem** | No existe (verificado: sin tabla ni campo): se modela con RENEWAL+DOWNSELL, workaround que además causa el sub-bug B del RSM. Primera etapa: benchmark (Zuora, Chargebee, Stripe Billing, Maxio, NetSuite) | Carelis/SimpliRoute, BAM-01, períodos sin cobro TiMining |
| 10 | **Sistema de notificaciones/avisos** | 🟡 EN CURSO LEÓN (infraestructura ya en prod, verificado 24-08). Complementar con los pedidos de los holdings: tareas pendientes (por emitir, renovaciones), alertas de desalineación, resumen semanal por correo | TiMining 29-07 + SimpliRoute 10-07 |

---

## 🟣 Estratégico / plataforma (se trabaja en la versión nueva del sistema)

20. **Modelos de pricing por rangos/tramos** (tabla SimpliRoute: piso fijo + tramos decrecientes; caso ValdiShopper CTR-2026-172). 🔶 Turboboy (CO) EN PAUSA — NO tocar data. 📎 memoria `feature_pricing_models_rangos`.
21. **MCP de Sapira**: servidor MCP propio para conectar agentes a datos y acciones de Sapira.
22. **Facturación electrónica nativa** — Leon (avance gradual).
23. **Cambio de backend completo** (Supabase RPC → NestJS/api-sapira) — Leon (en curso por partes).
24. **Integración KAME (TiMining)** — la lleva Leon; investigación completa en `docs/integraciones/kame/plan_integracion_kame.md`; 🔴 bloqueante API (DTE 110/USD).
25. **Contratos de duración indefinida + ajustes planificados** — facturar mes a mes hasta modificación, con escalamientos programados (% de precio en diciembre, auto-renovación con % definido en el ítem, cambios de cantidad/precio por año 2/3). Nace de SimpliRoute: venden sin plazo y los términos a diciembre existen para renovar todo junto con el ajuste anual (regla operativa actual de los upsells). 📎 memoria `project_v2_contratos_indefinidos_ajustes_planificados`.

---

## 📌 Decisiones registradas (no son bugs — no reabrir)

- **El callback del ERP que devuelve solo headers es la vía de excepción DESEADA** (28-07): cuando el cliente exige otro detalle en la OC se ajusta en el ERP, el header vuelve, y el detector de diferencias + "Ajustar a lo emitido" corrigen el detalle interno. El ex ítem "callback no actualiza items" queda **eliminado como bug** (reconfirmado por Domi 24-08).
- `FX=1.0` + `invoice_currency = moneda contrato` al **generar** facturas es correcto a nivel header: el FX real se define al activar según la política (el pendiente de la Tanda 1 es la herencia en líneas).
- `apply_contract_contraction` v2 quedó protegida contra `standardize` (patrón defer-FK).
- Trigger `prevent_end_date_update_when_active` es regla intencional (la decisión de flexibilizarla vive en Complejos #8).
- Prorrateo del 1er período RSM en ítems no recurrentes deja facturado>devengado (medido 6.65 vs 1.72) — **decisión 24-08: no migrar por caso borde**; si algún día se toca la función, el fix es exigir `is_recurring` en la condición FIX 1.3.
- Limitación V1 unificada: churn/downsell con unificada EMITIDA de por medio no la encuentra → protocolo: desconsolidar antes si está Por Emitir; si se emitió, NC manual.
- **El scheduler que emite solo el mes en curso NO es bug** (Domi 31-08): toma las Por Emitir desde el 1 del mes hasta la fecha actual; una PE que quedó con fecha de emisión de un mes anterior debe **actualizarse de fecha por el usuario** para entrar al ciclo. Regla de soporte — los casos rezagados (Dalvi julio, Copec LuvEnv) se resuelven en sesión operativa actualizando la fecha, no con código.
