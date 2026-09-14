# PostgreSQL Database Module (Supabase)

Este módulo proporciona integración con PostgreSQL usando TypeORM, específicamente configurado para Supabase.

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
├── entities/
│   ├── README.md               # Convención del ESPEJO de la DB por módulo (rediseño v2, paso 1)
│   ├── NOTAS-ESPEJO.md         # Rarezas verificadas en prod al espejar (insumo revisión Domi / paso 4)
│   ├── <modulo>/               # 16 carpetas (base-tenancy, fx, clientes, …, integraciones/*, sii): `*.espejo.ts` apagados
│   │                           # generados desde prod en vivo + README (diff de entities existentes) + snapshot + spec
│   ├── espejo.index.ts         # Barrel de todos los espejos (solo para los specs)
│   ├── espejo.existing.ts      # Reexport de las entities activas (solo para los specs)
│   ├── *.entity.ts             # Entities existentes (producción) — NO se modifican
│   └── base.entity.ts          # Entidad base con campos comunes (helper de módulos existentes)
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

> 🔴 Rediseño v2 (carril B): el espejo `entities/<modulo>/*.espejo.ts` se genera SOLO desde prod en vivo (MCP Supabase), es inerte en runtime y no toca las entities existentes. Ver `entities/README.md`.

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
| `seed/` | Datos semilla idempotentes. | 1 |

> **Qué es un asset y qué es una entity.** Si TypeORM lo puede declarar —tabla, columna, PK, FK, UNIQUE, CHECK, índice simple o parcial— lo declara la entity y se aplica con una migración revisada. Todo lo demás es un asset. **No hay fase `tables/`**: ninguna tabla se define como asset.
>
> Ejemplo completo de tabla creada por este camino: la entity `SapiraQuantityImport`, la migración `CreateSapiraQuantityImports`, el índice con expresión en `special-index/sapira_quantity_imports_source_key.sql`, el trigger y las 2 policies.

El corpus se regenera desde producción con `scripts/schema-as-code/fetch-catalog.ts` (captura, solo lectura) y `scripts/schema-as-code/generate-assets.ts` (emite los assets faltantes; nunca sobreescribe uno existente).

Cada asset aplicado queda registrado en `public.sapira_sql_asset_history` con su SHA-256. Un asset con el mismo checksum se omite en ejecuciones posteriores; si cambia, el runner falla para evitar reaplicar SQL mutable. Crea un archivo nuevo para cambios posteriores.

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

### Crear una tabla nueva (receta completa)

> **El DDL del esquema `public` vive en api-sapira**, no en las migraciones de Supabase del front.
> `front-sapira-vite/supabase/migrations/` queda para lo que es del front (Edge Functions, Storage, `auth.*`).

> 🔴 **La tabla la define su entity TypeORM**, no un asset: no existe fase `tables/`. Una tabla nueva
> se declara como entity y se aplica con una migración revisada (`migration:generate` → **revisar y
> recortar** → `migration:run`). El resto de las piezas sí son assets.

El orden de fases del manifest resuelve las dependencias solo, así que basta con poner cada pieza en su carpeta:

| Paso | Dónde | Qué va |
|---|---|---|
| 1 | `<tabla>.entity.ts` + migración | Columnas, PK, FKs, UNIQUE, CHECK e índices declarables, **con sus nombres reales**. Genera con `yarn migration:generate`, **revisa y recorta**: la migración generada incluye toda la deriva pendiente del resto del esquema. Agrega a mano `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, que TypeORM no modela |
| 1b | `types/` | Solo si la tabla usa un enum o una extensión nuevos |
| 1c | `special-index/` | Solo para índices con `gin`/`ivfflat` u orden explícito (`DESC`, `NULLS`) |
| 2 | `functions/` | Solo si necesitas una función nueva. **Revisa primero si ya existe**: `set_updated_at()` cubre el caso típico de `updated_at` |
| 3 | `triggers/nombre_trigger.sql` | `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` |
| 4 | `rls/nombre_policy.sql` | Una policy por archivo, `DROP POLICY IF EXISTS` + `CREATE POLICY`. Nombre de archivo = nombre de policy |
| 5 | entity | `<tabla>.entity.ts` en `entities/` (tabla propia, no espejo) + `forFeature` del módulo que la use |

**Por qué `ENABLE ROW LEVEL SECURITY` va en `tables/` y no en `rls/`:** los archivos de `rls/` se
generaron por ingeniería inversa desde producción, donde RLS ya estaba activo, así que **ninguno de los
361 activa RLS** — solo declaran policies. En una tabla nueva creada por el runner eso deja RLS
apagado y **las policies quedan inertes**. Activar RLS es parte de crear la tabla, así que va en su
asset. `assets-runner.spec.ts` tiene una guarda que falla si un asset de `tables/` crea una tabla sin
activar RLS.

Ejemplo de referencia completo: `tables/002-sapira-quantity-imports.sql` +
`triggers/sapira_quantity_imports_set_updated_at.sql` + `rls/sapira_quantity_imports_{select,service_role}.sql`.

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

**1d. Auditoría de objetos sin uso — pendiente.** Con `yarn schema:audit` (ver más abajo):
- **`cleanup_duplicate_partners_by_vat` y `cleanup_duplicate_pending_records`**: sin referencias
  aparentes, pero **no dejan rastro** al ejecutarse (no escriben en ninguna tabla de log) y **no están
  rotas**, así que no hay dato que pruebe que no corren. Auditar antes de decidir.
  ⚠️ Su hermana `cleanup_old_processed_records` **sí se usa**: el front la invoca con
  `supabase.rpc()` desde `OdooIntegrationClientes.tsx`. No eliminar.
- **Barrido `--unused-tables`**: ninguna tabla se ha revisado con `seq_scan + idx_scan = 0`, que es la
  señal más fuerte (prueba que la tabla nunca se leyó desde el reinicio de estadísticas, hace 490 días).
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

**2. Siete tablas sin RLS, con `GRANT` completo a `anon`.** Los permisos son uniformes en las 132
tablas: `ALL PRIVILEGES` para `anon`, `authenticated`, `postgres` y `service_role`. La contención la
hace RLS, no el GRANT — y estas siete no tienen RLS ni policies:
`client_entity_tax_id_normalization_conflicts`, `generic_export_vats`, `indicadores_economicos`,
`invoice_trigger_debug_logs`, `odoo_product_mappings`, `stripe_product_mappings`, `stripe_sync_jobs`.
Sobre ellas no hay ninguna capa de contención. Activar RLS es un cambio de comportamiento en
producción y puede romper lecturas legítimas del front: requiere revisar caso por caso.

**3. Cuatro tablas con RLS activo y cero policies** (`claude_skills`, `sii_cafs`, `sii_certificates`,
`sii_configurations`): solo accesibles por `service_role`. Verificar si es intencional.

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
las entities; el guard está en `src/modules/odoo/entities/odoo-stg-processing-status.spec.ts`.

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
