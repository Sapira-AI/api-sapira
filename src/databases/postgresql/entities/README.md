# Entities espejo de la base de datos (rediseño v2 · paso 1 · carril B)

> Espejo de las tablas de `public` del Supabase **de producción en vivo**, como entidades TypeORM organizadas **por módulo** (los módulos de `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md`). Paso 1 del plan (`docs/v2-rediseno/00-plan-y-metodo.md`): **tal cual existe hoy, sin rediseñar nada**. Mejoras y entidades nuevas: paso 2, después de la revisión de Domi.

## 🔴 Reglas que no se negocian

1. **Fuente de verdad = SOLO prod en vivo**: proyecto Supabase `hklompkypzqtglprfobu` (el `SUPABASE_URL` del `.env`; en el dashboard se llama "Sapira MVP"), leído por el MCP de Supabase en el momento de espejar. **Nunca** desde `supabase/schema.sql`, `supabase/migrations`, tipos generados ni JSON antiguos: son de otro proyecto u otra fecha y es la receta para el error (ya se comprobó drift en `custom_field_definitions` y en los triggers de `company_holdings`).
2. **Las entities existentes no se duplican**: las 55 clases `@Entity` activas del repo (`src/modules/*/entities/*.entity.ts` + las planas de esta carpeta + `base.entity.ts`) apuntan a tablas de producción. `database.module.ts` las carga por glob `src/**/*.entity.ts` y cada módulo las registra en `forFeature`. Las cuatro entidades antiguas `integration_salesforce_*`, cuyos destinos no existían en producción, fueron retiradas. Para cada tabla que ya tiene entity, el README de su módulo documenta **dónde está y su diferencia con prod** (columnas faltantes/sobrantes, tipo/nullable/default/length distintos, constraints e índices no declarados), calculada con la metadata TypeORM real de la entity. Inventario: `scripts/espejo/existing-entities.json`.
3. **Solo se crean las tablas sin entity, y nacen APAGADAS**: archivos `<tabla>.espejo.ts` (no `.entity.ts`) → no entran al glob de `database.module.ts` y ningún módulo los registra en `forFeature`. Cero impacto en el API hasta el paso 3, donde se renombran a `.entity.ts` y se completan las existentes con Leon. `database.module.spec.ts` vigila esto y que nadie habilite `synchronize`/`dropSchema`/`migrationsRun` (`synchronize: false` está hardcodeado); el spec de cada módulo vigila que no se dupliquen tablas con entity existente.
4. **Nada se rediseña ni se omite**: también se espejan las tablas con veredicto 🗑️/🔀 del 04/00. Las rarezas se anotan en `NOTAS-ESPEJO.md` (solo hechos verificados en vivo).

## Las tres lecturas (todas sin escribir nada)

| Herramienta | Entrega | Se guarda en |
|---|---|---|
| MCP `list_tables` (`schemas: ['public'], verbose: true`) | Tablas, filas, RLS, comentario de tabla; columnas con tipo, nullable, default, comentario, `unique`/`check` de una columna; PK; FKs | crudo: `scripts/espejo/snapshots/raw/list-tables.json` → por módulo `<modulo>.pgmeta.json` |
| MCP `execute_sql` con `SELECT` sobre `pg_constraint` + `pg_get_constraintdef`, `pg_indexes`, `pg_trigger` + `pg_get_triggerdef`, `pg_policies`, `information_schema.columns`, `pg_class`, `pg_enum` | Nombres de PK/UNIQUE/CHECK, uniques compuestos, ON DELETE/UPDATE, índices (incl. parciales y con expresión), longitud varchar / precisión numeric, enums con sus valores, triggers, policies con sus expresiones | crudo: `scripts/espejo/snapshots/raw/catalog.json` → por módulo `<modulo>.catalog.json` |
| `scripts/espejo/extract-existing-metadata.ts` (ts-node; construye la metadata TypeORM de las entities del repo sin conectarse) | Lo que las entities existentes declaran hoy: columnas, tipos, nullable, defaults, uniques, índices, FKs | crudo: `raw/existing-metadata.json` → por módulo `<modulo>.existing.json` |

`execute_sql` está bloqueado en el modo auto de Claude; en **modo manual** Domi aprueba cada consulta (las dos lecturas completas de las 130 tablas se hicieron el 2026-08-22). `scripts/espejo/build-snapshots.py` convierte los crudos en los snapshots por módulo.

## Estructura (una subcarpeta por módulo del doc 04/00) — 130 tablas = 55 con entity existente + 75 espejos creados

| Carpeta | Módulo (04/00) | Tablas | Existentes (documentadas con diff) | Espejos creados (apagados) |
|---|---|---|---|---|
| `base-tenancy/` | 1 · Base / Tenancy | 14 | 6 | 8 |
| `fx/` | 2 · FX y datos económicos | 7 | 4 | 3 |
| `clientes/` | 3 · Clientes | 11 | 5 | 6 |
| `cotizaciones-catalogo/` | 4 · Cotizaciones y catálogo | 5 | 4 | 1 |
| `contratos/` | 5 · Contratos | 17 | 1 | 16 |
| `facturacion/` | 6 · Facturación | 17 | 3 | 14 |
| `revenue/` | 7 · Revenue / períodos | 5 | 0 | 5 |
| `legacy/` | 8 · Legacy / onboarding | 4 | 0 | 4 |
| `conciliacion/` | 9 · Conciliación y pagos | 3 | 0 | 3 |
| `integraciones/salesforce/` | 10 · Integraciones | 12 | 11 | 1 |
| `integraciones/odoo/` | 10 · Integraciones | 6 | 5 | 1 |
| `integraciones/stripe/` | 10 · Integraciones | 7 | 7 | 0 |
| `integraciones/otras/` | 10 · Integraciones | 4 | 3 | 1 |
| `automatizaciones-ia/` | 11 · Automatizaciones, IA, notificaciones y correo | 13 | 3 | 10 |
| `suscripciones/` | 12 · Suscripciones (Stripe) | 2 | 0 | 2 |
| `sii/` | 13 · Emisión fiscal nativa | 3 | 3 | 0 |

Estado 2026-08-22: ✅ los 16 módulos generados y verificados (75 espejos: 947 columnas, 163 FKs, 25 UNIQUE, 55 CHECK, 184 índices declarados + 27 documentados sin declarar, 64 triggers y 238 policies en los JSDoc). Censo en vivo: 130 tablas base (el 04/00 estimaba ~128). Las **vistas** (`invoices_with_net_amounts`, `invoice_items_consolidated`) no se mapean. `analytics.semantic_catalog` (otro schema, FK a `company_holdings`) queda fuera del alcance de `public` — decisión pendiente. Tabla → carpeta: `scripts/espejo/module-map.json`.

Archivos de soporte en esta carpeta: `espejo.index.ts` (barrel de todos los espejos) y `espejo.existing.ts` (reexport de las entities activas) — los usan los specs para construir la metadata completa con todos los destinos de FK. Para promover un lote verificado durante QA, el DataSource puede cargar los espejos mediante `TYPEORM_LOAD_MIRROR_ENTITIES=true`; `schema:sync` por sí solo no los habilita.

## Convención de un espejo (tablas sin entity)

1. **Archivo** `<tabla-en-singular-kebab>.espejo.ts`, **clase** PascalCase singular (colectivos se mantienen: `FinancialSettings`, `InvoicesLegacy`). `@Entity('<tabla>')` con el nombre real. JSDoc de cabecera: origen (proyecto, herramienta, fecha), "APAGADO en runtime", filas, RLS, comentario de tabla, quién la referencia por FK, triggers, policies (nombre, comando, roles) y las notas de lo que no se pudo declarar (índices con expresión, FKs duplicadas).
2. **Propiedad = nombre de columna** (snake_case). `@Column` con el **tipo real de Postgres** (`timestamp with/without time zone`, `numeric` + `precision`/`scale`, `varchar` + `length`, `text[]`/`uuid[]`/`integer[]` con `array: true`, `jsonb`, `uuid`, `vector` de pgvector, enums con `type: 'enum'` + `enum: [...]` + `enumName`), `nullable` y `default` reales, comentario de columna como JSDoc. `created_at`/`updated_at` con default `now()` usan `@CreateDateColumn`/`@UpdateDateColumn`. Tipos TS: `numeric` → `number` (convención del repo), `bigint` → `string`, `jsonb` → `any`, arrays → `T[]`.
3. **Nombres reales de todo**: `primaryKeyConstraintName`, `@Unique('nombre', [...])`, `@Check('nombre', '<expresión real>')`, `@Index('nombre', [...], { unique, where })`. Los índices que respaldan PK/UNIQUE no se repiten; los que usan expresiones, orden (`DESC`), opclass o método `gin`/`ivfflat` no se pueden expresar con `@Index` → se documentan en el JSDoc y el README (27 en total).
4. **Una relación `@ManyToOne` por FK** con `onDelete`/`onUpdate` reales y `@JoinColumn({ name, referencedColumnName, foreignKeyConstraintName })`: hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, hacia el espejo del mismo módulo (`./`) o de otro módulo (`../<modulo>/`). Si prod tiene dos FKs sobre la misma columna, se declaran las dos con nombres `x` y `x2` (nota en el JSDoc).
5. Cada carpeta tiene `index.ts` (barrel), `README.md` (A: entities existentes con su diff · B: espejos creados con PK/UNIQUE/CHECK/FK/índices/triggers/policies · C: columnas exactas de cada espejo), `<modulo>.prod-snapshot.ts` (generado) y `<modulo>.entities.spec.ts` (metadata TypeORM en memoria vs snapshot: columnas + nullabilidad, PK, FKs + ON DELETE, UNIQUE, CHECK, índices; y que no hay duplicados). Los módulos sin tablas por crear (`integraciones/stripe`, `sii`) solo tienen README (sección A) y un barrel vacío.

## Cómo se genera (reproducible, sin tocar la DB)

```bash
# 1) MCP Supabase (proyecto hklompkypzqtglprfobu), ambas de solo lectura; el harness guarda la salida en un archivo:
#    list_tables(schemas ['public'], verbose true)            → scripts/espejo/snapshots/raw/list-tables.json
#    execute_sql(<consulta de catálogo, ver build-snapshots.py>) → scripts/espejo/snapshots/raw/catalog.json
# 2) metadata real de las entities existentes (sin conexión)
npx ts-node -r tsconfig-paths/register scripts/espejo/extract-existing-metadata.ts <tablas con entity…> > scripts/espejo/snapshots/raw/existing-metadata.json
# 3) snapshots por módulo
python3 scripts/espejo/build-snapshots.py scripts/espejo/snapshots/raw/list-tables.json scripts/espejo/snapshots/raw/catalog.json scripts/espejo/module-map.json scripts/espejo/existing-entities.json scripts/espejo/snapshots scripts/espejo/snapshots/raw/existing-metadata.json
# 4) generar (dos pasadas para resolver FKs entre módulos; el registro queda en scripts/espejo/generated-entities.json)
for pass in 1 2; do for m in base-tenancy fx clientes cotizaciones-catalogo contratos facturacion revenue legacy conciliacion integraciones/salesforce integraciones/odoo integraciones/stripe integraciones/otras automatizaciones-ia suscripciones sii; do python3 scripts/espejo/generate-espejo.py "$m"; done; done
# 5) formato + verificación
npx eslint --fix "src/databases/postgresql/entities/**/*.ts" && yarn build && npx jest src/databases/postgresql
```

Referencia histórica, no herramienta: `src/modules/database/database-generator.service.ts` (mapea mal arrays/enums, descarta defaults, no emite constraints).
