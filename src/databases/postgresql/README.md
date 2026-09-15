# PostgreSQL Database Module (Supabase)

Este módulo proporciona integración con PostgreSQL usando TypeORM, específicamente configurado para Supabase.

> 📘 **¿Vas a cambiar algo del esquema?** Empieza por **[`GUIA-CAMBIOS-DE-ESQUEMA.md`](./GUIA-CAMBIOS-DE-ESQUEMA.md)**:
> dónde va tu cambio, las recetas, y cómo se revisa una migración generada. Este README es la
> referencia del corpus y su estado; la guía es el procedimiento.

## 🔧 Configuración

### Variables de Entorno

Agrega estas variables a tu archivo `.env`:

```env
# Opción 1: URL completa de Supabase (Recomendado)
SUPABASE_DATABASE_URL=postgresql://postgres:[TU_PASSWORD]@db.[TU_PROJECT_REF].supabase.co:5432/postgres

# Opción 2: Configuración manual
SUPABASE_HOST=db.[TU_PROJECT_REF].supabase.co
SUPABASE_PORT=5432
SUPABASE_USERNAME=postgres
SUPABASE_PASSWORD=[TU_PASSWORD]
SUPABASE_DATABASE=postgres

# Configuraciones adicionales
SUPABASE_SYNCHRONIZE=false  # ¡NUNCA true en producción!
SUPABASE_LOGGING=false      # true para debug
```

### Obtener credenciales de Supabase

1. Ve a tu proyecto en [Supabase Dashboard](https://app.supabase.com)
2. Navega a **Settings** > **Database**
3. En la sección **Connection info**, encontrarás:
   - Host
   - Database name
   - Port
   - User
4. La contraseña es la que configuraste al crear el proyecto

## 📁 Estructura

```
src/databases/postgresql/
├── database.module.ts          # Configuración de TypeORM para Supabase
├── database.provider.ts        # Provider con métodos utilitarios
├── entities/                   # TODAS las entities del repo, organizadas por dominio
│   ├── README.md               # Convención del ESPEJO de la DB por módulo (rediseño v2, paso 1)
│   ├── NOTAS-ESPEJO.md         # Rarezas verificadas en prod al espejar (insumo revisión Domi / paso 4)
│   ├── <dominio>/              # 16 carpetas (base-tenancy, fx, clientes, …, integraciones/*, sii) según
│   │                           # scripts/espejo/module-map.json. Conviven tres cosas:
│   │                           #   *.entity.ts   entities del repo, que carga runtime
│   │                           #   *.espejo.ts   espejos inertes (fuera del glob), generados desde prod
│   │                           #   README + prod-snapshot + spec del módulo
│   ├── espejo.index.ts         # Barrel de todos los espejos (solo para los specs)
│   ├── espejo.existing.ts      # Reexport de las entities activas (solo para los specs)
│   ├── auth-user.entity.ts     # `auth.users` de Supabase: no es una tabla de `public`, va en la raíz
│   └── base.entity.ts          # Entidad base con campos comunes (clase abstracta, sin @Entity)
├── database.module.spec.ts     # Guard: sync protegido y el espejo (*.espejo.ts) no entra al glob de runtime
├── assets-runner.ts             # Runner de SQL no gestionado por TypeORM
├── assets.manifest.json         # Orden de directorios y overrides explícitos de assets
├── migrations/                  # Migraciones TypeORM: el DDL de tablas vive acá
├── types/                       # Extensiones y enums (van antes que cualquier tabla)
├── functions/                   # Funciones PostgreSQL
├── special-index/               # Índices que TypeORM no puede declarar (gin/ivfflat, orden explícito)
├── triggers/                    # Triggers PostgreSQL
├── rls/                         # Políticas Row Level Security
├── grants/                      # Permisos por rol (anon, authenticated, service_role)
├── seed/                        # Datos idempotentes posteriores a las migraciones
└── README.md                   # Esta documentación
```

> 🔴 Rediseño v2 (carril B): el espejo `entities/<dominio>/*.espejo.ts` se genera SOLO desde prod en vivo y es inerte en runtime. Convive en la misma carpeta con las entities del repo, que sí carga runtime; el generador no las toca. Ver `entities/README.md`.

### Promover un espejo

Un `.espejo.ts` es inerte: está fuera del glob `**/*.entity.ts`, así que ni el runtime lo carga ni
`schema:log` lo mira. Promoverlo lo convierte en la definición viva de su tabla.

1. **Verifica que no dependa de otro espejo sin promover.** Si el espejo importa otro `.espejo.ts`,
   promoverlo solo cargaría el otro en runtime saltándose este mismo control. Se promueve por lotes,
   en orden de dependencia.
2. Renombra `<tabla>.espejo.ts` → `<tabla>.entity.ts`.
3. Corre el generador (`python3 scripts/espejo/generate-espejo.py <modulo>`, dos pasadas sobre todos
   los módulos): detecta el archivo promovido, deja de emitir el espejo y arregla el barrel.
4. Agrega la ruta a `promotedMirrorEntities` en `database.module.spec.ts`.
5. Declara en las entities activas las FKs que ese espejo bloqueaba.
6. `yarn jest` y `TYPEORM_LOAD_MIRROR_ENTITIES=true yarn schema:log`.

> ⚠️ El generador **reescribe** el `.entity.ts` de un espejo promovido en cada corrida: sigue siendo
> un archivo generado. Lo que se edite a mano ahí se pierde. Si una tabla promovida necesita algo que
> el generador no produce, va en el generador, no en el archivo.

## 🧱 Assets SQL no-TypeORM

El runner `postgres:assets` aplica los `.sql` en siete fases, en este orden, con los archivos ordenados alfabéticamente dentro de cada una. `assets.manifest.json` declara las fases y permite adelantar rutas puntuales con `order`.

| Fase | Contiene | Cuenta |
|---|---|---|
| `types/` | Extensiones y enums. Van primero porque una columna puede referenciarlos. | 10 |
| `functions/` | Una función por archivo, `CREATE OR REPLACE`. | 310 |
| `special-index/` | Índices que TypeORM **no puede** declarar con `@Index`: método no btree (`gin`, `ivfflat`) u orden explícito (`DESC`, `NULLS`). Los parciales sí se declaran con `@Index({ where })` y **no** van acá. | 41 |
| `triggers/` | `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`. | 133 |
| `rls/` | Una policy por archivo. **No activan RLS**, solo la declaran. | 389 |
| `grants/` | Permisos por rol. Sin ellos, un entorno nuevo tiene tablas correctas e inaccesibles. | 1 |
| `seed/` | Datos semilla idempotentes. | 2 |

> **Qué es un asset y qué es una entity.** Si TypeORM lo puede declarar —tabla, columna, PK, FK, UNIQUE, CHECK, índice simple o parcial— lo declara la entity y se aplica con una migración revisada. Todo lo demás es un asset. **No hay fase `tables/`**: ninguna tabla se define como asset.
>
> Ejemplo completo de tabla creada por este camino: la entity `SapiraQuantityImport`, la migración `CreateSapiraQuantityImports`, el índice con expresión en `special-index/sapira_quantity_imports_source_key.sql`, el trigger y las 2 policies.

El corpus se regenera desde producción con `scripts/schema-as-code/fetch-catalog.ts` (captura, solo lectura) y `scripts/schema-as-code/generate-assets.ts` (emite los assets faltantes; nunca sobreescribe uno existente).

Cada asset aplicado queda registrado en `public.sapira_sql_asset_history` con su SHA-256. Un asset con el mismo checksum se omite en ejecuciones posteriores.

**Si el contenido cambió**, el runner distingue por fase:

- `functions/`, `triggers/`, `rls/`, `grants/` → **lo re-aplica** y actualiza el checksum (`REAPLICADO` en la salida). Re-aplicar converge: son `CREATE OR REPLACE` y `DROP … IF EXISTS` + `CREATE`. **Se edita el mismo archivo; el corpus describe el estado deseado y el historial lo lleva git.**
- `types/`, `special-index/`, `seed/` → **falla a propósito**. Ahí el archivo cambiaría y la base no (`DO … pg_type`, `CREATE INDEX IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), así que registrar el checksum nuevo sería que el historial mienta. Ese cambio es una transición: va en una migración.

```bash
# Solo descubre y muestra el orden; no requiere conexión.
yarn postgres:assets --plan

# Consulta el historial y muestra pendientes; no ejecuta DDL/DML.
SUPABASE_DATABASE_URL=postgresql://... yarn postgres:assets --dry-run --target qa

# Crea el historial y ejecuta los assets pendientes.
SUPABASE_DATABASE_URL=postgresql://... yarn postgres:assets --apply --target qa

# Producción requiere ambas confirmaciones explícitas.
SUPABASE_DATABASE_URL=postgresql://... yarn postgres:assets --apply --target production --allow-production --confirm-target production

# Aplicar UN asset puntual sin tocar el manifest (repetible). El path debe coincidir
# exacto con la ruta relativa mostrada por --dry-run; si no existe, falla.
SUPABASE_DATABASE_URL=postgresql://... yarn postgres:assets --apply --only rls/sapira_quantity_imports_select.sql
```

> `--only` es clave cuando el historial del runner aún no existe: un `--apply` sin filtro intentaría aplicar **todos** los assets ya presentes en la BD (RLS/triggers no idempotentes) y fallaría. Con `--only` aplicas y registras solo el asset nuevo.

`SUPABASE_DATABASE_URL` es la variable preferida; `DATABASE_URL` se acepta como alternativa. No ejecutes `apply` en producción sin verificar el plan y el respaldo de la base.

> **El `--target` se verifica contra la conexión real.** Antes de conectar, el CLI resuelve el project ref de Supabase desde la cadena de conexión y aborta si no corresponde al target declarado. Como `--target` sale de `DATABASE_TARGET ?? NODE_ENV ?? 'development'`, sin esta verificación un `.env` apuntando a producción dejaba `--apply` corriendo contra prod sin ninguna confirmación. Para operar contra un proyecto nuevo, decláralo primero en `SUPABASE_PROJECT_ENVIRONMENTS`.

### Crear una tabla nueva

La receta paso a paso está en **[`GUIA-CAMBIOS-DE-ESQUEMA.md`](./GUIA-CAMBIOS-DE-ESQUEMA.md)**, junto
con las de agregar una columna, una función, un trigger o una policy, y —lo más importante— **cómo se
revisa una migración generada**.

Lo que no se puede improvisar, resumido:

> 🔴 **La tabla la define su entity TypeORM**, no un asset: **no existe fase `tables/`**. Se declara
> como entity y se aplica con una migración revisada (`migration:generate` → **revisar y recortar** →
> `migration:run`). El resto de las piezas sí son assets.

> ⚠️ **`ENABLE ROW LEVEL SECURITY` va a mano en la migración.** Los 389 archivos de `rls/` salieron de
> producción, donde RLS ya estaba activo: **ninguno lo activa**, solo declaran policies. En una tabla
> nueva eso deja RLS apagado y las policies inertes, sobre una base donde el `GRANT` es
> `ALL PRIVILEGES` para `anon`.

Ejemplo de referencia completo: `entities/facturacion/sapira-quantity-import.entity.ts` +
`migrations/1788949477104-CreateSapiraQuantityImports.ts` +
`special-index/sapira_quantity_imports_source_key.sql` +
`triggers/sapira_quantity_imports_set_updated_at.sql` +
`rls/sapira_quantity_imports_{select,service_role}.sql`.

### Eliminar una tabla, una función u otro objeto

> 🔴 **Borrar el archivo del repo NO borra nada de la base.** El runner solo *aplica* archivos; nunca
> deduce que algo desapareció. Y **borrar una entity tampoco borra su tabla**: TypeORM solo ve las
> tablas que tienen entity, así que la deja huérfana en producción, con sus datos, índices y policies.

Por eso todo borrado son **dos acciones, y ninguna sustituye a la otra**:

| Acción | Qué resuelve |
|---|---|
| Una **migración** con los `DROP` | Elimina los objetos de las bases que ya existen (prod, QA) |
| **Borrar los archivos** del repo | Evita que un bootstrap desde cero los vuelva a crear |

Con solo lo primero, el próximo entorno nuevo recrea todo. Con solo lo segundo, producción se queda
con el objeto para siempre y ya nadie lo vigila.

**El `DROP` va en una migración, no en un asset.** Un asset describe *el estado actual* de un objeto;
un borrado es *una transición*. Un asset `DROP FUNCTION …` viviría en el corpus para siempre,
reaplicándose en cada entorno nuevo para borrar algo que nunca existió ahí.

**La migración se escribe a mano con `migration:create`.** `migration:generate` no sirve acá: al
quitar la entity la tabla sale de su radar y produce una migración vacía, y las funciones, triggers y
policies nunca estuvieron en su modelo.

#### Procedimiento

1. **Comprobar que está sin uso**, con evidencia y no por impresión:
   - `grep` del nombre en `api-sapira` **y** en `front-sapira-vite`.
   - ¿La referencia alguna otra función? (`pg_get_functiondef ~* '<nombre>'`)
   - ¿Está atada a un trigger o agendada en `cron.job`?
   - ¿Hay filas nuevas / llamadas registradas? Ojo con los límites: `track_functions` está en `none`,
     así que `pg_stat_user_functions` no tiene datos; y `pg_stat_statements` usa `track = top` y está
     al 95% de capacidad, así que la ausencia de una entrada **no prueba** que no se llamó.
   - Si la duda persiste: renombrar a `zz_deprecated_<nombre>` y esperar. Lo que la use falla ruidoso.
2. **Verificar dependencias**: ¿alguna FK apunta a la tabla? Si ninguna, el `DROP TABLE` va **sin
   `CASCADE`** — que silenciaría justo lo que querríamos ver si nos equivocamos.
3. **Exportar los datos** que se quieran conservar. Después del `DROP` solo quedan en el backup.
4. **Escribir la migración**: `yarn migration:create src/databases/postgresql/migrations/<Nombre>`.
   Primero las funciones, después la tabla. `DROP TABLE` ya se lleva sus policies, índices y FKs.
5. **`down()`**: si no es reversible de verdad, que lance un error explicándolo. Fingir
   reversibilidad es peor que declararla imposible.
6. **Borrar del repo**: assets de `functions/`, `triggers/`, `rls/`, `special-index/`; la entity y su
   export en `entities/espejo.existing.ts`; la entrada en `scripts/espejo/module-map.json`; y
   cualquier servicio o script que los importe.
7. **Aplicar**: `yarn migration:show --target <entorno>` → `yarn migration:run --target qa` → y en
   producción con `--allow-production --confirm-target production`.
8. **Verificar**: `yarn postgres:assets --plan` ya no lista los assets, `yarn test` en verde, y una
   captura nueva con `fetch-catalog.ts` confirma que el objeto no está.

### Guardas del corpus

`assets-runner.spec.ts` verifica sobre los archivos reales (no sobre un directorio temporal):

1. Todo asset de `functions/` declara la función (`CREATE [OR REPLACE] FUNCTION`), no solo su cuerpo.
   Existía porque el generador capturó `prosrc` en vez de `pg_get_functiondef` en 9 archivos, que
   quedaron como cuerpos plpgsql sueltos y hacían fallar cualquier `--apply` sin `--only`.
2. Todo asset de `functions/` cierra su delimitador dollar-quote.
3. Toda tabla nueva activa RLS en su propio asset.
4. El manifest declara las mismas fases que `ASSET_DIRECTORIES`, y ningún directorio con `.sql` queda
   fuera del manifest. (La constante omitía `tables` y `seed`; el manifest lo tapaba.)
5. `types/` es re-ejecutable: enums con guarda sobre `pg_type`, extensiones con `IF NOT EXISTS`.
6. `special-index/` solo contiene índices **no declarables** con `@Index`, y todos con `IF NOT EXISTS`.
7. `CREATE TYPE` y `CREATE EXTENSION` solo aparecen en `types/`.

### Deudas conocidas del corpus

> Estado del corpus tras la captura del 2026-09-09 (`scripts/schema-as-code/fetch-catalog.ts`).
> Ningún asset se ha aplicado todavía a producción: `--dry-run --target production` los reporta
> **todos como PENDIENTE**, así que ningún checksum está congelado y todo sigue siendo editable.

> ✅ **Resuelto (2026-09-09)**: 11 assets de `functions/` y 9 de `rls/` contenían versiones anteriores
> a las de producción, y aplicarlos habría causado regresiones silenciosas —`get_user_holding_id()`
> habría perdido la preferencia por `selected = true`, que decide qué holding ve un usuario en las
> policies; las 9 policies habrían perdido el subselect escalar que hace que la función se evalúe una
> vez por consulta en vez de una por fila. Los 120 assets desalineados se realinearon con
> `generate-assets.ts --overwrite-stale`. **El corpus ahora reproduce producción exactamente**, así
> que cualquier diferencia futura es deriva real. Esto solo fue posible porque ningún checksum estaba
> registrado; a partir del primer `--apply`, una corrección va en un asset nuevo.

**1. Assets que apuntan a objetos que ya no existen en producción.** 7 funciones, 13 triggers y 6
policies. Un `--apply` los crearía de vuelta. Hay que decidir si se eliminan o si producción perdió
algo que debía existir. Funciones huérfanas: `calculate_monthly_avg_fx`,
`check_partner_by_tax_id_before_insert`, `classify_invoice_line_before_insert`,
`set_invoice_processing_status`, `trigger_revenue_schedule_on_credit_note`, `trigger_rsm_on_churn`,
`update_monthly_avg_on_rate_change`.

> ⚠️ **Confirmado el 2026-09-14, y con consecuencia.** `set_invoice_processing_status` y
> `classify_invoice_line_before_insert` están efectivamente ausentes de producción: las tablas
> `odoo_invoices_stg` y `odoo_invoice_lines_stg` tienen **un solo trigger cada una**, el de
> `updated_at`. El comentario de la migración `AlignStagingProcessingStatusDefault` afirmaba lo
> contrario y basaba en eso su análisis de riesgo — se había escrito leyendo el corpus en vez de la
> base. Ya está corregido. **Las otras 5 funciones huérfanas merecen la misma verificación antes de
> usarlas como premisa de cualquier razonamiento.**

**1b. `integration_logs` está sin uso desde el 2026-04-27** (verificado en producción el 2026-09-09).
1378 filas históricas, **0 escrituras en los últimos 30 días**. Los logs de integración se migraron a
MongoDB: `OdooIntegrationLogService` y `StripeIntegrationLogService` están inyectados en
`odoo.service.ts` y `stripe-ingestion.service.ts`, los mismos servicios que antes escribían acá. El
front no la menciona. Lo único que la referencia son 6 funciones SQL que hacen `INSERT`
(`integrate_invoices_to_legacy`, `rollback_invoice_integration`, `cleanup_old_processed_invoices`,
`cleanup_duplicate_pending_invoices`, `cleanup_duplicate_pending_invoice_lines`,
`check_invoice_changes_before_insert`), **ninguna atada a un trigger ni invocada desde el código de
ninguno de los dos repos**. Pendiente: confirmar que nadie las ejecuta a mano antes de eliminar la
tabla, sus 2 policies, 7 índices y 3 FKs.

**1d. Auditoría de objetos sin uso — parcialmente resuelta el 2026-09-14.**
- ✅ **`cleanup_duplicate_pending_records`: eliminada.** No hacía falta auditarla: borra
  `WHERE processing_status = 'pending'` sobre una tabla cuyo CHECK no admite ese valor (verificado:
  0 filas con él). Era un **no-op estructural** — no podía borrar nada y nunca pudo.
- 🟡 **`cleanup_duplicate_partners_by_vat`: en ventana de observación.** Sí borra filas de forma
  irreversible y sin log, y su `EXECUTE` estaba concedido a **PUBLIC** —o sea invocable con la anon
  key—, porque es el default de `CREATE FUNCTION`. Se revocó con
  `grants/010-cleanup-functions-execute.sql`; ahora solo `postgres` y `service_role`. **El REVOKE es
  lo que fabrica la evidencia que `track_functions = 'none'` impide obtener**: durante la ventana,
  cualquier caller real aparece como un 42501 en los logs de PostgREST. Cerrada la ventana sin
  incidentes, va el `DROP` en una migración con `down()` que la recrea.
  Nota para cuando llegue: **está mal escrita, no solo sin uso** — agrupa solo por
  `raw_data->>'vat'`, así que dos partners legítimamente distintos con el mismo VAT (matriz y
  sucursal) se tratan como duplicados y se pierde el más antiguo.
  ⚠️ Su hermana `cleanup_old_processed_records` **sí se usa**: el front la invoca con
  `supabase.rpc()` desde `OdooIntegrationClientes.tsx`. No eliminar, y su GRANT quedó intacto.
- ⚠️ **El `EXECUTE` a PUBLIC lo tienen las 458 funciones de `public`**: es el default de
  `CREATE FUNCTION`, no una anomalía de estas dos. Endurecerlo en bloque
  (`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`) es un cambio aparte con su propia
  prueba; no rompería las 64 que el front llama por rpc, porque `anon` y `authenticated` tienen el
  `EXECUTE` también de forma explícita.
- **Barrido `--unused-tables`**: pendiente. `seq_scan + idx_scan = 0` es la señal más fuerte — prueba
  que la tabla nunca se leyó desde el reinicio de estadísticas (`stats_reset` = 2025-05-06).
- **`track_functions` está en `none`**, así que `pg_stat_user_functions` no tiene datos. Activarlo
  (`ALTER DATABASE postgres SET track_functions = 'pl'`) daría certeza positiva sobre funciones en
  unas semanas.

> **El front llama 64 funciones de `public` directamente con `supabase.rpc()`**, saltándose el
> backend. Toda auditoría tiene que buscar en `front-sapira-vite` además de en `api-sapira`: es el
> canal donde más fácil se pierde el rastro, porque el nombre viaja como string.

**1c. `services/generic-rls.service.ts` ejecuta DDL en runtime** — `ENABLE`/**`DISABLE ROW LEVEL
SECURITY`**, `CREATE INDEX`, `CREATE`/`DROP POLICY`. Hoy es **código muerto** (no está registrado en
ningún módulo y nadie importa `configs/rls-configurations.ts`), pero contradice que el runner sea el
único mecanismo de DDL y contiene un camino para apagar RLS. Candidato a eliminar.

**2. Tablas sin RLS, con `GRANT` completo a `anon`** — ✅ **resuelto el 2026-09-14. Las 131 tablas de
`public` tienen RLS.**

Los permisos son uniformes: `ALL PRIVILEGES` para `anon`, `authenticated`, `postgres` y
`service_role`, así que la contención la hace RLS y no el GRANT. Eran 9 las tablas sin ninguna capa:
las 7 conocidas más `sapira_sql_asset_history` y `sapira_typeorm_migrations` —las del propio tooling,
con `INSERT/UPDATE/DELETE/TRUNCATE` abiertos a `anon`, o sea el registro con el que se decide qué
aplicar—. Medido con la anon key: las 9 devolvían filas por PostgREST.

Se resolvió con `1789041000000-HabilitaRlsEnTablasSinContencion` (8 tablas; la novena,
`invoice_trigger_debug_logs`, se eliminó en `RetiraObjetosDebugMuertos`). Seis quedan **deny-all a
propósito** —ningún consumidor `supabase-js`, solo el backend, que tiene `rolbypassrls`— y los dos
catálogos globales llevan policy de lectura `TO authenticated`
(`rls/generic_export_vats_select_active.sql`, `rls/indicadores_economicos_select.sql`).

> **No podía romper el backend, y es medición y no suposición**: el rol de la conexión es `postgres`
> con `rolbypassrls = true`, y ya convivía con `FORCE ROW LEVEL SECURITY` en `invoices`, `products` y
> `workflow_step_documents` —`FORCE` somete incluso al dueño de la tabla a sus propias policies— sin
> ningún problema. Verificado además antes de aplicar con `yarn schema:verify-policies`, que simula
> la identidad de dos usuarios reales de holdings distintos dentro de una transacción de solo lectura.

**3. Cuatro tablas con RLS activo y cero policies** (`claude_skills`, `sii_cafs`, `sii_certificates`,
`sii_configurations`) — ✅ **verificado el 2026-09-14: es intencional y correcto. No es una deuda.**

RLS activo sin policies no es una tabla desprotegida: es **deny-all**. Para `anon` y `authenticated`,
`SELECT`/`INSERT`/`UPDATE`/`DELETE` devuelven cero o se rechazan. Son las cuatro tablas más cerradas
del esquema, y el estado corresponde con sus consumidores: ninguna tiene consumidor `supabase-js`;
`claude_skills` no tiene consumidor en absoluto (2 filas, sin entity viva); y las tres de SII las usa
solo `modules/sii/sii.service.ts` con repositorios TypeORM —o sea con el rol `postgres`, que tiene
`rolbypassrls`— y ya filtra por holding en la capa de aplicación. `sii_certificates` guarda
`key_vault_secret_name` y `thumbprint`: metadata de credenciales tributarias.

> 🚫 **Escribirles una policy sería ampliar acceso que nadie pidió, sobre tablas de secretos.** El
> linter de Supabase reporta «RLS enabled, no policy» como hallazgo y la reacción natural es
> «arreglarlo». `assets-runner.spec.ts` → *las tablas deny-all por diseño no reciben policies* falla
> si aparece un archivo en `rls/` que las mencione.
>
> Condición de reapertura: si aparece un consumidor `supabase-js`, se quita la tabla de esa lista y la
> policy es `tenant_isolation_select_<tabla>`. Para `sii_certificates` y `sii_cafs`, que no tienen
> `holding_id`, va vía `EXISTS` sobre `sii_configurations.holding_id`. Para `claude_skills` hay que
> decidir antes qué significa su `holding_id` nullable —probablemente «skill global»—, y eso es una
> decisión de producto, no de RLS.

**4. Anomalías de FK heredadas de producción.** Se replican tal cual; corregirlas es decisión de
negocio y va en su propio cambio:
- 8 FKs duplicadas sobre la misma columna (`workflow_step_documents` ×4, `invoices.holding_id`,
  `invoice_items.holding_id`). En `invoices` e `invoice_items` una es `CASCADE` y la otra `NO ACTION`:
  el `NO ACTION` no protege nada porque el `CASCADE` se evalúa igual.
- `ON DELETE SET NULL` sobre columna `NOT NULL` en `companies.companies_holding_fk` y
  `workflow_step_documents.fk_wsd_step`: borrar el padre lanza `23502` en runtime.
- 7 columnas FK con `DEFAULT gen_random_uuid()`: un INSERT que omita la columna genera un UUID que
  siempre viola la FK.

**4b. `processing_status` con un default que su propio CHECK rechaza — RESUELTO el 2026-09-09.**
En `odoo_invoices_stg` y `odoo_invoice_lines_stg` el default era `'pending'`, pero el CHECK solo
admite `create | update | processed | error`: un INSERT que omitiera la columna generaba una fila
inválida (23514). `odoo_partners_stg` nunca tuvo el problema (su default `'processed'` sí es válido).

Al analizar la cadena completa aparecieron dos cosas que cambian el diagnóstico:

- **En prod el default nunca llegaba al CHECK.** Postgres evalúa defaults → triggers `BEFORE ROW` →
  CHECK, y ambas tablas tienen un `BEFORE INSERT` que asigna la columna en *todas* sus rutas de
  salida, incluido el `EXCEPTION WHEN OTHERS`: `invoice_processing_status_classifier` →
  `set_invoice_processing_status()` y `classify_invoice_line_trigger` →
  `classify_invoice_line_before_insert()`. La trampa se arma solo cuando el trigger no corre:
  `session_replication_role = 'replica'` (replicación lógica, `pg_restore --disable-triggers`), un
  `ALTER TABLE ... DISABLE TRIGGER`, o **un esquema creado desde las entities sin aplicar los assets
  de `triggers/`** — que es exactamente el bootstrap del espejo. La anomalía era más peligrosa
  replicada que en el original.
- **`'pending'` es vocabulario muerto.** Ningún trigger lo emite y sus lectores no funcionan:
  `get_invoice_staging_stats` devuelve siempre 0 en `pending_invoices`/`pending_lines` y no tiene
  callers; `cleanup_duplicate_pending_records` es no-op; `process_partner_staging_to_client_entities`
  y `process_partner_staging_with_transformations` filtran `= 'pending'` sobre partners que solo
  producen create/update/processed/error, así que no procesan nada. `InvoiceProcessingService` ya
  redefinió "pending" como `create | update`.

**Decisión: cambiar el default a `'create'`, no ampliar el CHECK.** Admitir `'pending'` habría
legitimado un estado que ningún consumidor procesa —el loop filtra `In(['create','update','error'])`,
así que la fila quedaría invisible y descuadraría `getProcessingStats`—, cambiando un fallo ruidoso
por un agujero negro silencioso. `'create'` coincide con el fallback del propio clasificador y deja
la fila procesable si el trigger llegara a faltar; `DROP DEFAULT` era la alternativa purista, pero un
NULL tampoco entra en el loop. Aplicado en `1788953100000-AlignStagingProcessingStatusDefault` y en
las entities; el guard está en
`src/databases/postgresql/entities/integraciones/odoo/odoo-stg-processing-status.spec.ts`.

**5. Dependencias del esquema `auth` de Supabase.** `mrr_legacy.created_by` tiene
`DEFAULT auth.uid()` y varias funciones leen `auth.users`. Un bootstrap en Postgres vainilla necesita
un stub de `auth.uid()` y `auth.users`.

**6. Sin cobertura de vistas.** `invoices_with_net_amounts` e `invoice_items_consolidated` existen en
producción y no tienen asset ni entity.

## 🚀 Uso en Módulos

### 1. Importar el módulo

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostgreSQLDatabaseModule } from '../../databases/postgresql/database.module';
import { ExampleEntity } from '../../databases/postgresql/entities/example.entity';

@Module({
  imports: [
    PostgreSQLDatabaseModule,
    TypeOrmModule.forFeature([ExampleEntity])
  ],
  controllers: [TuController],
  providers: [TuService],
})
export class TuModulo {}
```

### 2. Usar en servicios

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExampleEntity } from '../../databases/postgresql/entities/example.entity';

@Injectable()
export class TuService {
  constructor(
    @InjectRepository(ExampleEntity)
    private readonly exampleRepository: Repository<ExampleEntity>,
  ) {}

  async findAll(): Promise<ExampleEntity[]> {
    return this.exampleRepository.find();
  }

  async create(data: Partial<ExampleEntity>): Promise<ExampleEntity> {
    const entity = this.exampleRepository.create(data);
    return this.exampleRepository.save(entity);
  }
}
```

## 🏗️ Crear Entidades

### Extender de BaseEntity

```typescript
import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../base.entity';

@Entity('mi_tabla')
@Index(['campo_unico'], { unique: true })
export class MiEntidad extends BaseEntity {
  @Column({
    type: 'varchar',
    length: 255,
    nullable: false,
  })
  nombre: string;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  metadata: Record<string, any>;

  @Column({
    type: 'boolean',
    default: true,
  })
  activo: boolean;
}
```

## 🔍 Métodos del Provider

El `PostgreSQLDatabaseProvider` incluye métodos utilitarios:

```typescript
// Inyectar el provider
constructor(
  private readonly postgresProvider: PostgreSQLDatabaseProvider,
) {}

// Ejecutar consulta SQL raw
const result = await this.postgresProvider.executeQuery(
  'SELECT * FROM mi_tabla WHERE activo = $1',
  [true]
);

// Verificar conexión
const isConnected = await this.postgresProvider.checkConnection();

// Obtener información de la base de datos
const dbInfo = await this.postgresProvider.getDatabaseInfo();

// Transacciones
const queryRunner = await this.postgresProvider.startTransaction();
try {
  // ... operaciones
  await this.postgresProvider.commitTransaction(queryRunner);
} catch (error) {
  await this.postgresProvider.rollbackTransaction(queryRunner);
}
```

## ⚠️ Consideraciones Importantes

### Seguridad
- `synchronize` está en `false` **en todos los entornos, sin excepción**. TypeORM no gestiona el esquema: lo audita con `yarn schema:log`.
- Todo comando que abre conexión verifica que el `--target` declarado corresponda al proyecto Supabase real (`connection-target.ts`). El identificador es el **project ref**, no el host: el pooler `aws-0-<region>.pooler.supabase.com` es compartido por todos los proyectos de la región.
- Un project ref desconocido no se opera: hay que declararlo en `SUPABASE_PROJECT_ENVIRONMENTS` (JSON `{"<ref>":"qa"}`).
- No dejes la URL de producción fija en tu `.env` de trabajo: pásala inline (`SUPABASE_DATABASE_URL=… yarn …`). Con la URL fija, cualquier comando que abra conexión —incluido levantar la app en local— habla con producción.
- Usa variables de entorno para las credenciales
- Supabase requiere SSL (ya configurado)

### Performance
- El pool de conexiones está configurado para máximo 20 conexiones
- Timeout de conexión: 2 segundos
- Timeout de idle: 30 segundos

### Migraciones
TypeORM es ORM y **detector de deriva**, nunca gestor de esquema. El único uso
legítimo sobre el esquema es `schema:log`, que calcula el SQL y no aplica nada:

```bash
# Mostrar el SQL que TypeORM aplicaría, sin aplicarlo
yarn schema:log
```

Si emite algo, las entidades y la base discreparon: el arreglo es corregir la
entidad o escribir el asset correspondiente, **nunca** dejar que TypeORM lo aplique.

> **TypeORM solo ve las tablas que tienen entity.** Verificado el 2026-09-09: con 56 entities
> cargadas contra un esquema de 130 tablas, `schema:log` emite **cero `DROP TABLE`** y no menciona
> ninguna de las 74 tablas sin entity. Dos consecuencias:
>
> - **Borrar una entity NO borra su tabla**: la deja huérfana en la base, con sus datos, índices y
>   policies. Para eliminarla hace falta un `DROP TABLE` explícito en una migración escrita a mano.
> - **`schema:log` no detecta objetos huérfanos.** Es un detector de deriva para lo que la entity
>   describe, no un inventario del esquema. Para eso está `scripts/schema-as-code/fetch-catalog.ts`
>   comparado contra `scripts/espejo/module-map.json`.

### `migration:generate` vs `migration:create`

| Qué cambia | Comando | Por qué |
|---|---|---|
| Columnas, índices, FKs, CHECKs de una tabla **con** entity | `migration:generate` | TypeORM lo deduce del diff entity ↔ base. **La migración generada siempre se revisa antes de aplicar.** |
| Borrar una tabla; funciones, triggers, policies, permisos, enums | `migration:create` + SQL a mano | Están fuera del modelo de TypeORM: nunca los genera, con entity o sin ella |

> Los scripts `schema:sync` y `schema:sync:prod` **fueron eliminados**. Decidían por
> `NODE_ENV`, no por la base real, así que con un `.env` de producción sincronizaban
> producción pasando todas las guardas. `database.module.spec.ts` verifica que no
> vuelvan a aparecer.

`synchronize` no gestiona triggers, funciones, RLS/policies, vistas ni índices
GIN/IVFFLAT o con expresiones. Estos objetos se aplican mediante `postgres:assets`
y deben revisarse junto con el cambio de entidades.

## 🔗 Enlaces Útiles

- [Supabase Database Documentation](https://supabase.com/docs/guides/database)
- [TypeORM Documentation](https://typeorm.io/)
- [NestJS TypeORM Integration](https://docs.nestjs.com/techniques/database#typeorm-integration)
