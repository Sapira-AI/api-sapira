# Roadmap Sapira ERP + FP&A (propuesta 19-10-2026)

> Para discutir con Domi y Leon. No arranca hoy: las prioridades vigentes de octubre (mejoras cortas, Automatizaciones + Slack/Teams, agentes, MCP) siguen; el ERP parte en noviembre como se dijo a Caravela. Índice: [README](README.md). Base: [referentes ERP](referentes-erp.md), [referentes FP&A](referentes-fpa.md), [estado y contexto](estado-sapira-y-contexto-latam.md), [base de datos](estrategia-base-de-datos.md), [comercial y pilotos](estrategia-comercial-y-pilotos.md).

## 1. Tesis

**Sapira ya es el ERP de ingresos.** Tiene lo que Sintropix promete y DualEntry cobra caro en la parte más difícil (contratos, pricing, facturación, DTE, devengo, cobranza). Lo que falta es el libro y la caja. El orden correcto es **de lo esencial a lo complejo según el dolor LatAm**, no según el índice de un ERP clásico:

1. **Caja** (lo que la pyme mira todos los días y nadie AI-native cubre con bancos LatAm y SII).
2. **Libro mayor y cuentas por pagar** (para dejar de depender del ERP viejo).
3. **Planificación** (presupuesto vs real, headcount, escenarios) sobre un libro que ya es nuestro.
4. **Consolidación, cierre y activos** (multi-entidad real, multi-book).
5. **Inventario y compras** solo si un piloto lo exige; nómina y gastos siempre por integración.

Alcance geográfico de arranque: **solo Chile hasta tener los dos pilotos** (decisión 3); el modelo de datos nace multi-país igual.

Tres principios de producto: **AI-first con firma humana** (todo documento entra como borrador, el agente propone bajo su identidad, el humano postea), **migración como producto** (sandbox con datos reales + tie-out contra el SII + 0 USD de implementación con FDE) y **cumplimiento local como foso** (DTE/RCV/F29 en Chile, CFDI/SAT en México, DIAN después).

## 2. Fases

| Fase | Ventana | Qué se entrega | Agente que la acompaña | Se vende como |
|---|---|---|---|---|
| **0 · Fundaciones** | nov-2026 (3 semanas) | Spec corta por módulo con OK de Domi; decisiones de BD (§5 del doc de BD); `document_events`; contrapartes (flags en `client_entities`); plan de cuentas con plantilla Chile + roles de cuenta; `gl_periods`; permisos nuevos; `/lab/tesoreria` y `/lab/contabilidad` creados con flag; rotación de la API key de Odoo; CI mínima con tests. | — | Nada todavía: teaser en eTM Day (19–21 nov) y lista de pilotos |
| **1 · Caja** | nov-2026 → ene-2027 | Conexión bancaria (Fintoc, solo Chile; decisión 3) + cartolas; `bank_movements` generalizado con categorización por reglas + IA y "pregunta cuando no cuadra"; posición de caja consolidada por compañía y moneda; **RCV del SII** → facturas recibidas como AP esperado; flujo proyectado 13 semanas y 12 meses con `expected_flows` (AR existente + AP del RCV + recurrentes detectados + impuestos F29/PPM + manual) y escenarios de FX; versión guardada del forecast y precisión semanal; alerta de caja mínima. | **Tesorero**: resumen diario/semanal por Slack, Teams o correo ("hoy tienes X, en 4 semanas te faltan Y"), clasifica movimientos, pide confirmación en dudas, propone adelantar cobros o posponer pagos | **Sapira Tesorería**: primer módulo para pilotos no SaaS. Reutiliza conciliación v2 y proyección de cobros |
| **2 · Libro y pagos** | ene → mar-2027 | `gl_journal_entries/lines` con posteo automático desde devengo (RSM), facturas, NC, pagos, bancos y bills; asientos manuales con aprobación; cuentas por pagar completas (aprobación, órdenes de pago, archivo al banco); IVA: libro de compras y ventas desde `fd_documents` y **propuesta de F29**; estados financieros (EERR, balance, flujo directo e indirecto, mayor, balance de comprobación 8 columnas); bloqueo de período en persistencia; **migrador**: import desde Odoo (XML-RPC existente) y Excel de Defontana/Softland/Nubox, mapeo de plan de cuentas por IA, saldos de apertura, 12–24 meses de historia, tie-out (TB por período, RCV vs libros, F29 vs IVA), parallel run 1 mes. | **Contador**: propone cuenta y asiento por documento, detecta anomalías antes de postear (Benford, duplicados, montos atípicos), arma el checklist de cierre y dice "qué falta para cerrar". **Migrador**: mapea el plan y explica cada diferencia del tie-out | **Sapira Contabilidad**: reemplazo del ERP local para servicios y software; "migración en días con cuadratura contra el SII" |
| **3 · Planificación** | mar → may-2027 | Versiones y escenarios de plan, líneas al grano cuenta × dimensión × mes, drivers (FX, DSO, DPO, precio, cargas), **headcount** como objeto (actual vía Buk/Rankmi/Talana + posiciones), presupuesto vs proyección vs real con **explicación de variaciones por dimensión** (patrón Scan), presupuesto de caja que nace del 13 semanas y de los contratos, sync programado a Google Sheets y export Excel; `budgets` actuales (cash_in, bookings) absorbidos. | **Analista**: redacta el comentario de variación con fuentes, propone el reforecast, responde "¿por qué subió X?" con drill al asiento | **Sapira Planificación**: presupuesto y forecast sin planilla suelta |
| **4 · Consolidación y cierre** | may → jul-2027 | Intercompany posteado en ambas entidades, eliminaciones, traducción y CTA, revalorización FX al cierre, **multi-book** tributario e IFRS pymes, activos fijos con depreciación, gastos anticipados, checklist de cierre con responsables y adjuntos, Contabilidad Electrónica del SII (Diario, Mayor, Balance XML firmados) si un piloto lo pide. | **Cerrador**: corre el checklist, genera eliminaciones y revalorizaciones como borradores, reporta días de cierre | **Sapira para holdings**: varias sociedades y países en un libro |
| **5 · Extensiones** | 2S-2027 según pilotos | Segundo país según el piloto que lo pida: México (Fintoc bancos, CFDI emitido y recibido vía PAC o Belvo fiscal) o Perú (Prometeo, SUNAT); después DIAN; compras y órdenes de compra, inventario básico, pasarelas de pago, factoring/adelanto de facturas como fuente de caja, MCP del ERP (lectura amplia, escritura con validate), API pública. | **Comprador**, agentes externos vía MCP | Por industria |

Cada fase cierra con la regla dura del repo (doc funcional en el centro de ayuda, doc técnica, reglas, tests) y con un piloto usándola en producción detrás de flag.

## 3. Estrategia de desarrollo: ramas, flags y laboratorio

- **Mismos repos, no repos nuevos.** El ERP reutiliza tenancy, guards, BFF, `components/ui`, data-table, 360, migas, integraciones y agentes. Un repo aparte duplicaría todo eso y rompería la atomicidad factura → asiento.
- **Ramas cortas por pieza, no una rama larga por producto.** Una rama `erp` viva seis meses chocaría con cada mejora rápida que pasa a producción (migraciones, entities, `PERMISOS_BFF`, sidebar) y con los specs de espejo que comparan entities contra el snapshot de prod. En su lugar: ramas `erp/<pieza>` que salen de `domi` (o de `qa`) y vuelven en días; el código llega a `qa` y `main` **apagado**.
- **Apagado = tres capas que ya existen**: módulo Nest con sus permisos `VIEW_/EDIT_` nuevos (nadie los tiene hasta que se asignan), página en `/lab/<modulo>` bajo `DESIGN_LAB_ENABLED` + `VIEW_LAB`, y un flag por holding (`holding_settings.erp_modules jsonb` o `holding_integration_settings`) para activar Tesorería, Contabilidad y Planificación por piloto. Al publicarse, cada módulo pasa a su ruta final con `switch-rutas-finales.md`.
- **Migraciones aditivas y aplicadas temprano**: toda tabla nueva se aplica en QA y prod en cuanto se mergea (vacía, sin tráfico), siguiendo `GUIA-CAMBIOS-DE-ESQUEMA.md`. Así el espejo no se rompe y nunca hay una "gran migración" al final. Cambios a tablas existentes (`bank_movements`, `client_entities`, `budgets`) solo con columnas nuevas y vistas de compatibilidad; ningún dato de holdings reales se toca sin OK y respaldo.
- **Carriles**: Domi + Claude lleva Tesorería, Contabilidad y Planificación en sesiones por módulo (una spec corta + OK por pieza, como hoy); Leon sigue en facturación electrónica nativa, seguridad y después conectores bancarios y SII/RCV (misma familia que api-factura). Soporte y mejoras rápidas siguen intercaladas en `domi` como hasta ahora.
- **Construir con IA, también adentro**: el migrador y los agentes usan el mismo catálogo de acciones y `claude_skills`; el benchmark propio de tareas contables (patrón DualEntry) nace de los casos del banco de escenarios con base real que ya está en los transversales.

## 4. Lo que se hace distinto a los referentes

| Referente hace | Sapira hace |
|---|---|
| DualEntry: 13.000 bancos vía agregador US, quote-only, migración en 24 h con equipo CPA en EE. UU. | Fintoc/Belvo/Prometeo + cartolas; precio publicado por sociedad; migración con tie-out **contra el SII** que el cliente puede verificar; FDE con experiencia en finanzas |
| Sintropix: libro primero, 2 personas, sin migración ni precio | Ingresos ya en producción, caja primero, migración como producto, precio publicado |
| Abacum/Aleph: FP&A como producto aparte, sin bancos ni factura electrónica, 20–75 k USD | Caja y presupuesto nativos del order-to-cash; impuestos y factoring como flujos de caja; español nativo sin marcas |
| Todos: "la IA falla 1 de 3" y lo venden como humano en el loop | Igual, pero con **cola de preguntas** (la IA pregunta cuando no cuadra) y etiquetas "Confirmado / Hipótesis / Pendiente" en cada respuesta |

## 5. Hitos verificables

| Fecha | Hito |
|---|---|
| 19–21 nov 2026 | eTM Day: Sapira Tesorería en teaser, 2 pilotos comprometidos por carta de intención |
| 15 dic 2026 | Fase 0 cerrada; conexión bancaria y RCV leyendo datos de un piloto en QA |
| 31 ene 2027 | Piloto 1 usa Tesorería en producción (13 semanas semanal por Slack) |
| 31 mar 2027 | Piloto 2 cierra un mes completo en Sapira Contabilidad en paralelo con su ERP anterior; tie-out cuadrado |
| 31 may 2027 | Presupuesto 2027 de ambos pilotos cargado y BvA mensual con comentarios del Analista |
| 30 jun 2027 | Primer cliente pagando ERP (Tesorería + Contabilidad) fuera de los pilotos; MCP del ERP en beta |

## 6. Riesgos y mitigaciones

- **Capacidad del equipo** (Domi + Claude, Leon a tiempo parcial): fases con MVP explícito y un piloto por módulo; nada se construye sin un piloto que lo use ese mes.
- **Conciliación es donde se pierde la confianza** (reseñas de DualEntry): conservar el motor determinista actual, sumar IA solo como sugerencia con confianza y fallback a pregunta; medir precisión desde el día uno.
- **Cobertura bancaria parcial hasta 2027**: cartolas como ciudadano de primera clase y categorización que funciona igual con archivo.
- **Deriva de ramas y espejo de esquema**: ramas cortas, migraciones aplicadas temprano, flags.
- **Dispersión comercial**: la oferta "Empieza 2027" de ingresos sigue siendo la venta principal hasta el 15-12; el ERP se vende solo a pilotos hasta junio.
- **Competencia**: Sintropix (discurso) y Defontana/Siigo/Buk (canal) se mueven a "finanzas con IA"; la ventaja de Sapira es tener ingresos reales corriendo y un camino por etapas, no una landing.

## 7. Decisiones tomadas por Domi el 19-10-2026 (Fase 0)

| # | Decisión | Resuelto | Consecuencia |
|---|---|---|---|
| 1 | Dónde viven las tablas nuevas | **Prefijos en `public`** (`gl_`, `ap_`, `fd_`, `tr_`, `fp_`, `mg_`); schemas propios solo si más adelante se extiende el tooling | Ninguna tarea de tooling en Fase 0; carpetas de entities por dominio |
| 2 | Nombres en el producto | **Tesorería, Contabilidad, Planificación**; la palabra ERP solo en marketing e inversionistas | Rutas finales `/tesoreria`, `/contabilidad`, `/planificacion`; permisos `VIEW_/EDIT_TESORERIA`, `_CONTABILIDAD`, `_PLANIFICACION` |
| 3 | Países de la Fase 1 | **Solo Chile hasta tener 2 pilotos** (Fintoc + RCV del SII + F29). El segundo país lo decide el piloto que lo pida | México (Belvo fiscal, CFDI) y Perú (Prometeo, SUNAT) salen de Fase 1 y quedan como extensiones; el modelo sigue siendo multi-país (`country` en documentos fiscales, adaptador por agregador) |
| 4 | Headcount y nómina | **Integración + planilla**: Buk, Rankmi y Talana como fuente de asientos y personas; import por planilla para quien no las use; posiciones planificadas sí se cargan en Sapira | Sin formularios de empleados en Fase 3; nómina propia fuera de alcance |
| 5 | `budgets` actual | **Absorber con migración** a `fp_plan_versions` / `fp_plan_lines` como versión `cash_in` | Migración de datos con OK explícito y respaldo en `sapira_backups.*` cuando llegue Fase 3; un solo modelo de plan |
| 6 | Precio | **Publicado por sociedad y volumen, implementación incluida** (doc comercial §4) | Tabla de precios en la web al lanzar (jun-2027); pilotos sin costo hasta entonces |
