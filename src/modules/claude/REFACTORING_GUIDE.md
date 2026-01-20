# Guía de Refactorización del Sistema de Skills

## Estado Actual

### ✅ Completado

1. **Estructura de tipos e interfaces** (`skills/skill-definition.interface.ts`)

    - Definición de `SkillDefinition`
    - Definición de `SkillParameter`, `SkillDatabase`, `WidgetConfig`
    - Interfaces para ejecución: `SkillExecutionContext`, `SkillExecutionResult`

2. **Query Builder Dinámico** (`skills/query-builder.ts`)

    - Construye queries SQL dinámicamente basado en parámetros
    - Soporta múltiples operadores: =, !=, >, >=, <, <=, IN, NOT IN, LIKE, IS NULL
    - Maneja GROUP BY y ORDER BY dinámicos
    - Método `buildUnionQuery` para combinar múltiples queries

3. **Skill Executor** (`skills/skill-executor.ts`)

    - Ejecuta skills usando el query builder
    - Procesa parámetros y aplica defaults
    - Calcula fechas automáticamente para mode=snapshot y mode=series
    - Genera widgets basado en configuración de la skill
    - Manejo de errores estandarizado

4. **Catálogo de Skills de MRR** (`skills/catalog/mrr-skills.ts`)

    - `get_mrr`: Skill principal para consultar MRR
        - Soporta mode: snapshot (último período) o series (histórico)
        - Soporta group_by: company, client, currency, product, momentum
        - Soporta currency_mode: system, contract, company
    - `get_mrr_by_company`: MRR agrupado por compañía
    - `get_mrr_by_currency`: MRR agrupado por moneda

5. **Índice del Catálogo** (`skills/catalog/index.ts`)
    - Exporta `SKILLS_CATALOG` con todas las skills disponibles
    - Funciones helper: `getSkillByName()`, `getAllSkills()`

## 🔄 Pendiente

### 1. Refactorizar ClaudeService

Necesitas modificar `claude.service.ts` para:

#### a) Actualizar imports

```typescript
import { DynamicQueryBuilder } from './skills/query-builder';
import { SkillExecutor } from './skills/skill-executor';
import { getAllSkills, getSkillByName } from './skills/catalog';
import { SkillDefinition } from './skills/skill-definition.interface';
```

#### b) Actualizar constructor

```typescript
constructor(
  private readonly configService: ConfigService,
  private readonly dataSource: DataSource,
  @Inject('SUPABASE_CLIENT') private readonly supabaseClient: SupabaseClient,
  private readonly queryBuilder: DynamicQueryBuilder,
  private readonly skillExecutor: SkillExecutor
) {
  // ... código existente
}
```

#### c) Reemplazar método `getActiveSkills`

```typescript
private getActiveSkills(): SkillDefinition[] {
  return getAllSkills();
}
```

#### d) Reemplazar método `executeSkill`

```typescript
private async executeSkill(context: SkillExecutionContext): Promise<SkillExecutionResult> {
  const skill = getSkillByName(context.skill_name);

  if (!skill) {
    return {
      success: false,
      error: `Skill '${context.skill_name}' no encontrada`,
    };
  }

  return await this.skillExecutor.executeSkill(skill, {
    skillName: context.skill_name,
    parameters: context.parameters,
    holdingId: context.holding_id,
  });
}
```

#### e) Eliminar métodos obsoletos

-   `createSkill()`
-   `updateSkill()`
-   `deleteSkill()`
-   `getSkillById()`
-   `listSkills()`
-   `toggleSkill()`
-   `executeMrrSeries()` (reemplazado por skill executor)
-   `executeMrrByCompany()` (reemplazado por skill executor)
-   `mapSkillFromDb()`

#### f) Actualizar método `sendMessage`

Cambiar línea 45:

```typescript
// Antes:
const skills = useSkills ? await this.getActiveSkills(holdingId) : [];

// Después:
const skills = useSkills ? this.getActiveSkills() : [];
```

Cambiar líneas 59-63 para usar SkillDefinition:

```typescript
if (skills.length > 0) {
	requestParams.tools = skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		input_schema: {
			type: 'object',
			properties: skill.parameters.schema,
			required: skill.parameters.required,
		},
	}));
}
```

### 2. Actualizar ClaudeModule

Agregar providers en `claude.module.ts`:

```typescript
import { DynamicQueryBuilder } from './skills/query-builder';
import { SkillExecutor } from './skills/skill-executor';

@Module({
  providers: [
    ClaudeService,
    DynamicQueryBuilder,
    SkillExecutor,
    // ... otros providers
  ],
  // ...
})
```

### 3. Actualizar ClaudeController

Eliminar endpoints relacionados con CRUD de skills:

-   `POST /claude/skills` (createSkill)
-   `GET /claude/skills` (listSkills)
-   `GET /claude/skills/:skillId` (getSkill)
-   `PUT /claude/skills/:skillId` (updateSkill)
-   `DELETE /claude/skills/:skillId` (deleteSkill)
-   `PUT /claude/skills/:skillId/toggle` (toggleSkill)

Mantener solo:

-   `POST /claude/message` (sendMessage)

## Cómo Agregar Nuevas Skills

### Ejemplo: Skill de Facturas

1. Crear archivo `skills/catalog/invoice-skills.ts`:

```typescript
import { SkillDefinition } from '../skill-definition.interface';

export const GET_INVOICES_SKILL: SkillDefinition = {
	name: 'get_invoices',
	description: 'Obtiene facturas filtradas por estado, fecha o cliente',

	parameters: {
		required: [],
		optional: ['status', 'date_from', 'date_to', 'client_id'],
		schema: {
			status: {
				type: 'array',
				description: 'Estados: draft, posted, paid, cancelled',
			},
			date_from: {
				type: 'date',
				description: 'Fecha inicio YYYY-MM-DD',
			},
			date_to: {
				type: 'date',
				description: 'Fecha fin YYYY-MM-DD',
			},
			client_id: {
				type: 'string',
				description: 'ID del cliente',
			},
		},
	},

	database: {
		tables: ['invoices'],
		baseQuery: `
      SELECT 
        invoice_id,
        invoice_number,
        client_name,
        invoice_date,
        total_amount,
        status
      FROM invoices
      WHERE {{WHERE_CLAUSE}}
    `,
		filters: {
			status: {
				column: 'status',
				operator: 'IN',
				parameterName: 'status',
			},
			date_from: {
				column: 'invoice_date',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'invoice_date',
				operator: '<=',
				parameterName: 'date_to',
			},
			client_id: {
				column: 'client_id',
				operator: '=',
				parameterName: 'client_id',
			},
		},
		orderBy: ['invoice_date DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			columns: ['invoice_number', 'client_name', 'invoice_date', 'total_amount', 'status'],
			format: {
				total_amount: 'currency',
				invoice_date: 'date',
			},
		},
	},
};

export const INVOICE_SKILLS = [GET_INVOICES_SKILL];
```

2. Actualizar `skills/catalog/index.ts`:

```typescript
import { MRR_SKILLS } from './mrr-skills';
import { INVOICE_SKILLS } from './invoice-skills';

export const SKILLS_CATALOG: SkillDefinition[] = [...MRR_SKILLS, ...INVOICE_SKILLS];
```

## Preguntas que el Sistema Puede Responder

Con las skills de MRR implementadas, el sistema puede responder:

1. ✅ "MRR de este mes"
2. ✅ "MRR por compañía este mes"
3. ✅ "MRR últimos 12 meses"
4. ✅ "MRR últimos 6 meses"
5. ✅ "MRR últimos 3 meses"
6. ✅ "MRR por segmento últimos 6 meses" (usando group_by)
7. ✅ "MRR por cliente últimos 6 meses" (usando group_by)
8. ✅ "MRR este mes por moneda de contrato"
9. ✅ "MRR este mes por moneda de contrato, por moneda"
10. ✅ "MRR en moneda del sistema"

## Ventajas del Nuevo Sistema

1. **Sin base de datos para skills**: Las skills son código, más fáciles de versionar y mantener
2. **Queries dinámicas**: El query builder construye SQL basado en parámetros
3. **Reutilizable**: Misma skill puede responder múltiples preguntas variando parámetros
4. **Escalable**: Agregar nuevas skills es solo crear un archivo TypeScript
5. **Type-safe**: Todo está tipado con TypeScript
6. **Testeable**: Cada componente (query builder, executor, skills) es testeable independientemente
