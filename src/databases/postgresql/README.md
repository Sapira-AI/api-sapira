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
├── functions/                   # Funciones PostgreSQL
├── special-index/               # Índices especiales (directorio opcional, preparado para futuro uso)
├── triggers/                    # Triggers PostgreSQL
├── rls/                         # Políticas Row Level Security
├── seed/                        # Datos idempotentes posteriores a schema sync
└── README.md                   # Esta documentación
```

> 🔴 Rediseño v2 (carril B): el espejo `entities/<modulo>/*.espejo.ts` se genera SOLO desde prod en vivo (MCP Supabase), es inerte en runtime y no toca las entities existentes. Ver `entities/README.md`.

## 🧱 Assets SQL no-TypeORM

El runner `postgres:assets` aplica los `.sql` de `functions`, `special-index` (si existe), `triggers`, `rls` y `seed`, sin modificar ni depender de la configuración TypeORM. Por defecto los directorios se ejecutan en ese orden y los archivos se ordenan alfabéticamente. `assets.manifest.json` permite cambiar la prioridad: las rutas incluidas en `order` se ejecutan primero, en el orden declarado.

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
```

`SUPABASE_DATABASE_URL` es la variable preferida; `DATABASE_URL` se acepta como alternativa. No ejecutes `apply` en producción sin verificar el plan y el respaldo de la base.

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
- `TYPEORM_SCHEMA_SYNC` está desactivado por defecto en todos los entornos.
- En local y QA, usa `TYPEORM_SCHEMA_SYNC=true` solo después de revisar `yarn schema:log`.
- En producción, la sincronización requiere además `TYPEORM_ALLOW_PROD_SYNC=true`, `TYPEORM_SCHEMA_BACKUP_CONFIRMED=true` y `SCHEMA_SYNC_CONFIRMATION=production`. Las tres variables deben inyectarse solo en el despliegue aprobado posterior a QA.
- Usa variables de entorno para las credenciales
- Supabase requiere SSL (ya configurado)

### Performance
- El pool de conexiones está configurado para máximo 20 conexiones
- Timeout de conexión: 2 segundos
- Timeout de idle: 30 segundos

### Migraciones
El CLI comparte la misma configuración que Nest y permite inspeccionar el SQL
sin escribir cambios:

```bash
# Mostrar el SQL de TypeORM sin aplicarlo
yarn schema:log

# Sincronizar local/QA tras revisar el log
TYPEORM_SCHEMA_SYNC=true yarn schema:sync

# Producción: solo desde el despliegue aprobado, con respaldo confirmado
TYPEORM_SCHEMA_SYNC=true \
TYPEORM_ALLOW_PROD_SYNC=true \
TYPEORM_SCHEMA_BACKUP_CONFIRMED=true \
SCHEMA_SYNC_CONFIRMATION=production \
yarn schema:sync:prod
```

`synchronize` no gestiona triggers, funciones, RLS/policies, vistas ni índices
GIN/IVFFLAT o con expresiones. Estos objetos se aplican mediante `postgres:assets`
y deben revisarse junto con el cambio de entidades.

## 🔗 Enlaces Útiles

- [Supabase Database Documentation](https://supabase.com/docs/guides/database)
- [TypeORM Documentation](https://typeorm.io/)
- [NestJS TypeORM Integration](https://docs.nestjs.com/techniques/database#typeorm-integration)
