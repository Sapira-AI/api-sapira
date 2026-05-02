# Scripts de Migración de Currencies

Este directorio contiene los scripts necesarios para crear y poblar la tabla `currencies` en Supabase.

## Archivos

### 1. Entidad TypeORM

-   **Ubicación**: `src/modules/banco-central/entities/currency.entity.ts`
-   **Descripción**: Definición de la entidad Currency para TypeORM

### 2. Migración de Supabase

-   **Ubicación**: `sapira-ai/supabase/migrations/20260501193300_create_currencies_table.sql`
-   **Descripción**: Script SQL que crea la tabla `currencies` con datos iniciales

### 3. Script SQL directo

-   **Ubicación**: `scripts/create-currencies-table.sql`
-   **Descripción**: Script SQL standalone que puede ejecutarse directamente en PostgreSQL

### 4. Script de verificación

-   **Ubicación**: `scripts/migrate-currencies.ts`
-   **Descripción**: Script TypeScript para verificar el estado de la migración

## Estructura de la tabla

```sql
CREATE TABLE currencies (
    code VARCHAR(3) PRIMARY KEY,           -- Código ISO 4217 (USD, CLP, etc.)
    name VARCHAR(100) NOT NULL,            -- Nombre en inglés
    name_es VARCHAR(100),                  -- Nombre en español
    symbol VARCHAR(10),                    -- Símbolo ($, €, etc.)
    decimal_places INTEGER DEFAULT 2,      -- Decimales (0 para CLP, 2 para USD)
    is_active BOOLEAN DEFAULT true,        -- Si está activa
    odoo_currency_id INTEGER,              -- ID en Odoo
    country VARCHAR(50),                   -- País
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE
);
```

## Monedas incluidas

| Código | Nombre         | Símbolo | Decimales | Odoo ID | País           |
| ------ | -------------- | ------- | --------- | ------- | -------------- |
| USD    | US Dollar      | $       | 2         | 2       | United States  |
| CLP    | Chilean Peso   | $       | 0         | 34      | Chile          |
| CLF    | Chilean UF     | UF      | 2         | 158     | Chile          |
| MXN    | Mexican Peso   | $       | 2         | 49      | Mexico         |
| COP    | Colombian Peso | $       | 0         | 37      | Colombia       |
| PEN    | Peruvian Sol   | S/      | 2         | 135     | Peru           |
| EUR    | Euro           | €       | 2         | 1       | European Union |
| UYU    | Uruguayan Peso | $       | 2         | 162     | Uruguay        |

## Cómo ejecutar la migración

### Opción 1: Supabase CLI (Recomendado)

```bash
cd sapira-ai
npx supabase db push
```

### Opción 2: Supabase Dashboard

1. Ve a tu proyecto en Supabase Dashboard
2. Navega a SQL Editor
3. Copia el contenido de `sapira-ai/supabase/migrations/20260501193300_create_currencies_table.sql`
4. Pega y ejecuta el SQL

### Opción 3: PostgreSQL directo

```bash
psql -h <host> -U postgres -d postgres -f scripts/create-currencies-table.sql
```

### Opción 4: Script de verificación

```bash
cd api-sapira-ai
npm run ts-node scripts/migrate-currencies.ts
```

Este script:

-   Muestra el contenido de la migración
-   Verifica si la tabla ya existe
-   Lista las monedas si la tabla está creada

## Políticas RLS

La tabla tiene las siguientes políticas de Row Level Security:

1. **Anyone can view active currencies**: Cualquiera puede ver monedas activas
2. **Authenticated users can view all currencies**: Usuarios autenticados pueden ver todas

## Uso en la aplicación

```typescript
import { Currency } from '@/modules/banco-central/entities/currency.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// En tu servicio
constructor(
  @InjectRepository(Currency)
  private currencyRepository: Repository<Currency>
) {}

// Obtener todas las monedas activas
const currencies = await this.currencyRepository.find({
  where: { is_active: true }
});

// Obtener una moneda específica
const usd = await this.currencyRepository.findOne({
  where: { code: 'USD' }
});

// Obtener moneda por ID de Odoo
const currency = await this.currencyRepository.findOne({
  where: { odoo_currency_id: 34 }
});
```

## Notas

-   Los códigos de moneda siguen el estándar ISO 4217
-   Los IDs de Odoo corresponden a los IDs reales en la instancia de Odoo
-   La tabla usa `ON CONFLICT DO UPDATE` para permitir re-ejecutar la migración sin errores
-   Las monedas sin decimales (CLP, COP) tienen `decimal_places = 0`
