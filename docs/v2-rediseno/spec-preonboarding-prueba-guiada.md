# Spec — Pre-onboarding y prueba guiada (acortar el ciclo de venta)

> **Estado: propuesta en discusión** (Domi, 25-09-2026). Origen: post-mortem del ciclo Lazarillo
> (demo excelente → 7+ días de silencio esperando NDA + data). Documento comercial hermano en
> Notion: "Flujo pre-onboarding y prueba guiada" (Comercial + Marketing). Decide: Domi + Leon;
> requiere revisión legal antes de operar (clickwrap + Ley 21.719).

## Problema

El ciclo de venta muere en dos handoffs posteriores a la demo:

1. **Firma del NDA** — hoy es prerequisito de todo (acceso, propuesta) cuando lo único que
   realmente protege es la data real del cliente.
2. **Envío de datos del cliente** — hoy la propuesta espera la data, cuando el precio de
   suscripción se calcula con ~8 datos declarados; la data real solo dimensiona la implementación.

Benchmarks: demos self-guided cierran ~38% vs ~25% del screen-share y acortan el ciclo ~23%;
el pricing de la categoría (Chargebee et al.) es por tramos de volumen **declarado** con true-up;
el estándar de la industria para pruebas es un **Acuerdo de Evaluación clickwrap**, no un NDA
firmado aparte.

## Flujo objetivo

**Regla de expectativas (transversal)**: la demo en vivo es **siempre con datos demo**
(empresa ficticia); el acceso con datos del cliente existe recién cuando comparte su data y tras
las **24h de carga**. Se comunica así en la web post-gate y en la reunión — nadie llega a la demo
esperando ver sus números. Antes del gate, la web no detalla el flujo (solo `/precios` y el CTA).

| Instancia | Qué pasa | Regla |
|---|---|---|
| Web (pre-gate) | Precios de lista públicos en `/precios` → CTA **«Mira la demo»**: formulario corto (contacto + 4-5 datos declarados) | self-service, 2 min |
| Web (post-gate) | Desbloquea: **video de la demo** + **estimación personalizada** (plan + fee integraciones) + **explicación del flujo** (demo en vivo con empresa demo; prueba 7 días con tus datos al compartir tu data, carga en 24h) + CTA **«Agenda tu demo en vivo»** (`/contacto`). Cada envío = lead al CRM con sizing preliminar | inmediato |
| Web (no agendó) | Lead con contacto + sizing ya en el CRM → **secuencia de nurture** (2-3 correos: re-link al video, un caso, «tu estimación sigue disponible») | correos días 2, 5 y 10 |
| Demo (reunión) | Usuario propio del prospecto en la **empresa demo (datos ficticios, nunca del cliente)**, navega acompañado; actividad registrada (navegación, clicks, preguntas a agentes) | 15–20 min en la reunión |
| Demo (cierre) | Acepta **Acuerdo de Evaluación** (clickwrap) + completa **formulario de sizing completo** (8 campos, pre-llenado desde la web) | misma sesión |
| Post demo | Acceso a empresa demo en **modo lectura 48h**, corte total al día 3 | expiración automática |
| Post demo | **Propuesta in-app + correo** calculada del sizing declarado; asesoría de implementación como línea opcional desde el día 1 | ≤ 72h post demo |
| Prueba con su data (paralelo) | **Solo al compartir data real** (cubierta por el acuerdo): su empresa montada con ~3 contratos en **24h de carga** → **7 días de prueba** desde el primer acceso, sesión de cierre agendada desde el día 1 | data → +24h → 7 días |
| Firma | **La propuesta se acepta y firma dentro de la app** (clickwrap con registro de aceptación — estándar de la industria: T&C/MSA + aceptación del order form = contrato) → inicia servicio + onboarding. Transición mientras no exista la pieza in-app: OK por correo (práctica actual) o PandaDoc si el cliente exige firma formal | — |

Cambio estructural: **el acuerdo deja de ser prerequisito de la venta; solo lo es de la data
real**. PandaDoc queda como fallback para clientes que exijan su propio NDA.

## Piezas de producto

Ordenadas por dependencia; los frentes de UI viven en `front-sapira` (web pública y sistema),
los contratos/endpoints acá.

| # | Pieza | Repo(s) | Notas |
|---|---|---|---|
| 1 | **Cuenta de prueba efímera** en empresa demo: rol lectura/demo, expiración automática (48h lectura → corte día 3), aislada del holding demo real de reportes internos | api + front | reutiliza roles/permissions; job de expiración |
| 2 | **Registro de actividad de prospectos**: navegación + preguntas a agentes, consultable por el equipo comercial | api + front | reutiliza `agent_logs`/`ai_messages`; requiere consentimiento declarado en el acuerdo |
| 3 | **Clickwrap Acuerdo de Evaluación**: aceptación con registro de usuario, timestamp, IP y versión del texto; texto versionado | api + front | validez FES Ley 19.799; cláusula datos personales (Ley 21.719 vigente dic-2026); revisión legal previa. Definición 25-09: lo acepta el usuario (CFO/finanzas), **sin exigir representante legal** — eso era lo que alargaba el ciclo; formalidad mayor solo si el cliente la pide (PandaDoc). Idea futura (no ahora): firma de la propuesta por el rep. legal despachada desde la app con datos pre-llenados por el CFO |
| 4 | **Formulario de sizing completo** (in-app, cierre de demo; pre-llenado desde la web): MRR/facturación, nº clientes, facturas mes/año, compañías y países, monedas, CRM, ERP/facturadores, dónde consolidan | api + front | alimenta la propuesta y los gatillos de asesoría |
| 5 | **Web «Mira la demo»** (nombre comercial — no "calculadora": los precios de lista ya son públicos en `/precios` y un calculador sonaría a cobros extra): formulario corto (contacto + 4-5 datos declarados) → desbloquea **video de la demo + estimación personalizada + explicación del flujo demo→prueba** (expectativas: demo en vivo con datos demo; datos propios al compartir data + 24h de carga) + CTA «Agenda tu demo en vivo» (`/contacto`). Referencia: Maxio no muestra nada sin contacto | front (www) + api (lead) | cada envío = lead calificado al CRM con sizing preliminar; disclaimer de estimación; descartadas por ahora demo interactiva y tour público — solo video |
| 6 | **Propuesta in-app**: visualización + **aceptación/firma dentro del sistema** (clickwrap con registro), con copia por correo — el camino por defecto del cierre; correo/PandaDoc solo como respaldo | api + front | v1 puede ser PDF adjunto + estado + botón aceptar |
| 7 | **Video de la demo** (contenido, no software): guion + grabación; se re-graba cuando el front nuevo esté maduro | — | insumo de la pieza 5 |
| 8 | **Nurture de leads web sin demo agendada**: secuencia de 2-3 correos; puede operar manual antes de ser producto | — | rescata el gap web→agendamiento |

**Gatillos de asesoría de implementación** (objetivos, desde el sizing): sin ERP · consolidación
en planillas · 3+ países · alto volumen de contratos legacy · data sin estructurar.

## Métricas del funnel

Web: formulario corto → video visto → demo agendada. Sistema: demo → acuerdo aceptado (objetivo:
misma sesión) · demo → sizing · sizing → propuesta (≤72h) · propuesta → firma · % de pruebas con
data real cargada. Baseline: Lazarillo (demo → 7+ días de silencio).

## Decisiones pendientes

- [ ] Validación comercial del flujo (Domi + Camila) y piloto manual con Lazarillo
- [ ] Revisión legal del Acuerdo de Evaluación (clickwrap + Ley 21.719)
- [ ] Tramos de precio por MRR/volumen y fee por tipo de integración (SII / ERP / CRM)
- [ ] Copy exacto del CTA web («Mira la demo» u otro) y guion/producción del video · evaluar teaser abierto 60-90s
- [ ] Redactar secuencia de nurture (2-3 correos)
- [ ] Domi: consultar al ex equipo qué se firmó al contratar Maxio (referencia clickwrap)
- [ ] Priorización de las piezas 1–8 vs roadmap actual (decisión Domi + Leon)
