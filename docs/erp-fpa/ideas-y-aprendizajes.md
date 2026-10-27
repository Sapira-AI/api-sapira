# Ideas y aprendizajes para el ERP + FP&A

> Bitácora viva de insumos que todavía no son spec: señales de competidores, material externo que sirve
> de input para diseñar módulos o agentes, y decisiones de producto que surgen de los pilotos. Cada
> entrada dice de dónde viene, qué aporta y a qué fase del [roadmap](roadmap-erp-fpa.md) se mapea.
> Cuando una idea madura, sale de aquí hacia una spec corta (regla vigente: cada módulo arranca con
> spec corta + OK de Domi). Índice: [README](README.md).

## 1. IA en conciliación bancaria — guía de Francisco Javier López Martín (27-10-2026)

**Fuente:** post de LinkedIn de Francisco Javier López Martín (34 k seguidores, #iaplicada), que acompaña
una guía de 70+ páginas y un kit de skills sobre conciliación con IA (foco bancos españoles/europeos,
con algo de México, Perú y Chile). Post: `linkedin.com/feed/update/urn:li:activity:7520042201498918912`.

**Por qué la conciliación es difícil (su diagnóstico, coincide con lo que vemos en producción):**

1. **Desfase temporal**: el banco registra hoy lo que el ERP contabiliza mañana.
2. **Referencias inconsistentes**: la misma operación llega con glosas distintas, incompletas o irreconocibles.
3. **Cobros agrupados**: las pasarelas abonan un neto tras comisiones, devoluciones y retenciones.
4. **Correspondencias múltiples**: un importe puede cubrir varias facturas, clientes o sociedades.
5. **Grupos internacionales**: cada país suma bancos, divisas, calendarios, ERPs y planes contables.

Y la regla que subraya: **no basta con que el saldo cuadre** — cada diferencia se explica, se resuelve
y queda con evidencia para el cierre y la auditoría. No hay un método único: depende del banco, el ERP,
los medios de pago, el volumen y las reglas contables (de ahí la capa configurable, ver §3).

**Los 6 aportes de la IA según la guía → input directo para los agentes de la Fase 1 (Match Maker / Tesorero):**

| Aporte | Qué significa para Sapira |
|---|---|
| 1. Normalización | Extractos, mayores, Excel, CSV, camt.053 → estructura común. Ya tenemos cartolas; faltará normalizar formatos nuevos por piloto. |
| 2. Propuestas de cruce | Fechas, importes, referencias y tolerancias con **nivel de confianza por coincidencia**. Es exactamente `useMovementSuggestions` (exacta/alta/probable con puntaje y razones): validado. |
| 3. Clasificación | Separar partidas claras de ambiguas **sin forzar conciliaciones dudosas**. Refuerza nuestra "cola de preguntas cuando no cuadra" (roadmap Fase 1). |
| 4. Detección de incidencias | Duplicados, comisiones, devoluciones, movimientos ausentes, fuera de patrón. Candidato a catálogo de alertas de Match Maker. |
| 5. Gestión de excepciones | Cada caso preparado con **causa probable, documentación, responsable y acción pendiente**. Es la estructura que debería tener cada ítem de la cola (no solo "pendiente"). |
| 6. Trazabilidad | Registro revisable para cierre, control interno y auditoría. Calza con `document_events` append-only de la Fase 0. |

**Guardrail que repite (y que ya es nuestra regla):** la IA reduce búsqueda y clasificación; el
profesional valida la coincidencia, decide el tratamiento contable y aprueba. Agentes con aprobación
humana, nunca posteo autónomo.

**Qué tomar:** los puntos 4 y 5 son los que hoy no tenemos diseñados — un catálogo de incidencias y
una ficha de excepción (causa probable + evidencia + responsable + acción) como unidad de trabajo de la
cola. Entra como requisito de la spec de conciliación de la Fase 1.

## 2. Sintropix lanza "Email Intake" (27-10-2026)

**Fuente:** post de Borja Márquez de la Plata (co-founder & CTO de Sintropix, YC F26). Ficha completa
del competidor en [referentes-erp.md §1](referentes-erp.md).

**Qué anunciaron:** el usuario conecta el correo de su empresa y Erwin (su agente) busca ahí la
información que falta —contexto de transacciones, comprobantes, respaldos— y la adjunta donde
corresponde, para acelerar la conciliación bancaria y dejar de perseguir comprobantes. Nació de cerrar
un mes junto a sus clientes y detectar dos cuellos de botella: transacciones sin contexto y la
persecución de comprobantes.

**Lecturas:**

- **Valida el diagnóstico del roadmap** (riesgo: la conciliación es donde se gana o pierde la
  confianza) y precisa el cuello real: no es el algoritmo de matching, es el **contexto faltante**.
  Su respuesta es ir a buscar la respuesta al correo antes de preguntar; la nuestra (cola de
  preguntas) pregunta. Son complementarias: el intake reduce preguntas.
- **El correo como fuente de evidencia es una pieza que nuestro plan no tenía.** Una casilla de intake
  (o conexión Gmail/Outlook de solo lectura) alimentaría tres cosas a la vez: candidatos y evidencia
  para la conciliación (Fase 1), facturas de proveedor para el AP esperado (complementando el RCV del
  SII, que ya nos da las recibidas con valor legal — ventaja que Sintropix no explota), y comprobantes
  de pago para la cobranza del O2C que ya corre. **Candidata a la Fase 1 o 2; decidir con el primer
  piloto que persiga comprobantes por correo.**
- **Señal competitiva:** ellos van de libro → caja; nosotros de caja → libro. La colisión es la
  conciliación. Nuestro foso: O2C en producción (sabemos qué factura esperar y cuándo), motor
  determinista de conciliación v2 ya construido, RCV/DTE nativo.
- **Cadencia:** construyen desde el cierre de mes real de sus clientes y anuncian en público cada mes.
  Nuestro método es el mismo (nada se construye sin un piloto usándolo ese mes); la diferencia es que
  vendemos ERP solo a pilotos por decisión comercial. Registrar cada release de ellos aquí.

## 3. Pilotos que comparten datos: qué es base del sistema y qué es configurable

**Contexto (Domi, 27-10):** hay empresas que compartirán sus datos para armar el nuevo servicio. El
servicio se entiende personalizado por cliente, pero eso obliga a decidir qué es **base del sistema**
(igual para todos) y qué queda **configurable por holding**, con el mismo patrón que ya usa el O2C en
producción: datos maestros + campos personalizados, no forks por cliente.

**El patrón que ya funciona en O2C y se extiende a los módulos nuevos:**

- **Base (código, igual para todos):** partida doble inmutable, períodos y bloqueos, motor de
  conciliación, devengo, FX, cola de aprobaciones, trazabilidad (`document_events`). Lo determinista
  vive en la API; ningún cálculo cambia por cliente.
- **Configurable por holding (datos, no código):** plan de cuentas (plantilla "Chile pyme" como punto
  de partida + cuentas propias, ya diseñado en la [spec Fase 0](spec-fase-0-fundaciones.md)),
  dimensiones de presupuesto (área/mercado/segmento, decidido en la demo Xbrein), reglas de
  categorización y matching por historial del holding, catálogo de incidencias y tolerancias de
  conciliación (ver §1), campos personalizados sobre los maestros (como hoy en clientes/contratos),
  flags `holding_settings.erp_modules` por módulo.
- **Personalizado por el especialista (servicio, no producto):** el levantamiento del piloto configura
  lo anterior y diseña/ajusta los agentes al proceso del cliente ([visión del giro, 21-10]): el experto
  configura, los agentes mantienen al día, el experto supervisa y aprueba lo que pesa. Si un piloto
  pide algo que no se puede expresar como configuración, es una señal de que falta una pieza en la
  base — se decide con spec corta, nunca con un fork.

**Regla operativa con los datos de los pilotos:** los datos reales que compartan alimentan el diseño
(qué incidencias existen, qué tolerancias, qué campos faltan) y el banco de escenarios de prueba;
nunca se cargan a demo ni se muestran a otros prospectos (regla vigente: Hanka es el único holding
demo). Cada levantamiento debería dejar como artefacto la lista "qué pidió este cliente que no era
configurable" — ese es el backlog honesto de la base.

---

*Creado el 27-10-2026. Nuevas entradas arriba de las viejas dentro de cada sección, con fecha.*
