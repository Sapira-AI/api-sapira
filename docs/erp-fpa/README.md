# Sapira ERP + FP&A · investigación, ingeniería inversa y plan

> Carpeta creada el 19-10-2026 en una sesión de solo análisis (sin cambios de código ni de base de datos). Es el insumo de la "línea estratégica nueva (nov-2026): ERP + FP&A AI-first para Latam; spec pendiente" de `ROADMAP-V2.md`. Nada de esto está aprobado ni construido: son propuestas para decidir con Domi y Leon.

## Documentos

1. [Referentes ERP: Sintropix y DualEntry](referentes-erp.md) · fichas, arquitectura inferida, patrones AI-first, GTM, pares LatAm y globales, brechas.
2. [Referentes FP&A: Aleph, Abacum y herramientas de caja](referentes-fpa.md) · fichas, modelo de datos FP&A inferido, guardrails de IA, GTM, qué copiar y qué hacer distinto en LatAm.
3. [Punto de partida: qué tiene Sapira y qué ofrece la infraestructura LatAm](estado-sapira-y-contexto-latam.md) · inventario de lo reutilizable, brecha ERP, deuda a cerrar, bancos, facturación electrónica, ERPs locales.
4. [Estrategia de base de datos](estrategia-base-de-datos.md) · misma base y nuevos dominios, principios, tablas propuestas por dominio, convenciones, orden de construcción, riesgos.
5. [Roadmap ERP + FP&A](roadmap-erp-fpa.md) · tesis, 5 fases con agente y oferta por fase, estrategia de ramas y flags, hitos, riesgos, decisiones pendientes.
6. [Estrategia comercial y pilotos](estrategia-comercial-y-pilotos.md) · posicionamiento, perfil de pilotos por industria, oferta, hipótesis de precio, calendario, métricas.
7. [Spec corta · Fase 0 Fundaciones](spec-fase-0-fundaciones.md) · plan de cuentas, períodos por mes y libro, `document_events`, contrapartes, permisos, laboratorio con flag por holding; sus 5 decisiones ya tomadas (§9), a la espera del OK de arranque en noviembre.
8. [Ideas y aprendizajes](ideas-y-aprendizajes.md) · bitácora viva: señales de competidores (Sintropix Email Intake), material externo como input de agentes (IA en conciliación), y la regla base-del-sistema vs configurable por holding para los pilotos que comparten datos.

## Resumen ejecutivo

- **Sapira ya es el ERP de ingresos.** Contratos, pricing, facturación, DTE nativo, devengo IFRS 15, cobranza, conciliación AR, períodos, FX y presupuestos genéricos están en producción. Falta el libro mayor, cuentas por pagar, tesorería y planificación completa.
- **Los referentes dicen lo mismo**: la IA propone bajo su identidad, el humano postea; todo documento entra como borrador; controles en la capa de persistencia; MCP con permisos del rol; la migración (sandbox con datos reales, tie-out, implementación incluida) es la cuña comercial; la conciliación es donde se pierde la confianza. DualEntry levantó 90 M USD con eso; Sintropix lo promete con 2 personas y 10 clientes; Aleph y Abacum hacen FP&A sin bancos ni factura electrónica a 20–75 k USD.
- **El foso LatAm está libre**: factura electrónica como fuente de AR y AP (RCV del SII, CFDI del SAT), bancos vía Fintoc/Belvo/Prometeo más cartolas, impuestos y factoring como flujos de caja, multimoneda con FX volátil, español sin marcas. Ningún AI-native global lo cubre.
- **Orden propuesto**: Caja (nov → ene) → Libro y pagos con migrador (ene → mar) → Planificación (mar → may) → Consolidación y cierre (may → jul) → extensiones por piloto. Un agente por fase (Tesorero, Contador y Migrador, Analista, Cerrador) sobre el catálogo de acciones ya diseñado.
- **Base de datos**: misma base Supabase, dominios nuevos con prefijo (`gl_`, `ap_`, `fd_`, `tr_`, `fp_`, `mg_`), partida doble inmutable con `book` desde el día uno, documentos fiscales separados de las facturas comerciales, `expected_flows` como corazón de la caja, evolución de `bank_movements`, `client_entities` y `budgets` sin romperlos.
- **Desarrollo**: mismos repos, ramas cortas `erp/<pieza>`, código a `qa` y `main` apagado detrás de permisos nuevos, `/lab/<modulo>` y flag por holding; migraciones aditivas aplicadas temprano para no romper el espejo de esquema.
- **Comercial**: dos pilotos de industrias no SaaS (servicios a la minería o logística, y agro o educación), 6 meses sin costo con FDE y carta de intención antes del eTM Day; precio publicado por sociedad y volumen con implementación incluida; la venta principal hasta el 15-12 sigue siendo Ingresos.

## Decisiones ya tomadas (Domi, 19-10-2026)

Prefijos en `public`; nombres Tesorería / Contabilidad / Planificación; solo Chile hasta tener 2 pilotos; headcount por integración (Buk, Rankmi, Talana) y planilla; `budgets` se absorbe con migración; precio publicado por sociedad y volumen. Detalle en [roadmap §7](roadmap-erp-fpa.md#7-decisiones-tomadas-por-domi-el-19-10-2026-fase-0).

## Hallazgos que no esperan al ERP

- `src/modules/odoo/README.md` tiene una API key de producción de Odoo en texto plano y commiteada: rotar y borrar (Leon).
- Confirmar con `yarn schema:status` si las migraciones `Budgets` y `BankReconciliationV2` están aplicadas en QA y prod.
