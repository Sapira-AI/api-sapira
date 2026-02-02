# HoldingAccessGuard

## Descripción

Guard que valida que el usuario autenticado tiene acceso al `holdingId` recibido en el header `X-Holding-Id`.

## Funcionamiento

El guard realiza las siguientes validaciones:

1. **Verifica autenticación**: Comprueba que el usuario esté autenticado
2. **Extrae el holdingId**: Obtiene el valor del header `X-Holding-Id`
3. **Valida acceso**: Consulta la tabla `user_holdings` para verificar que el usuario tiene asociado ese holding
4. **Agrega al request**: Si la validación es exitosa, agrega `validatedHoldingId` al objeto request

## Uso

### Aplicar a un controlador completo

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingAccessGuard } from '@/guards/holding-access.guard';

@Controller('odoo/connections')
@UseGuards(SupabaseAuthGuard, HoldingAccessGuard) // Aplicar ambos guards
export class OdooConnectionController {
	// Todos los endpoints de este controlador validarán el holdingId
}
```

### Aplicar a un endpoint específico

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { HoldingAccessGuard } from '@/guards/holding-access.guard';

@Controller('odoo/connections')
export class OdooConnectionController {
	@Get()
	@UseGuards(HoldingAccessGuard) // Solo este endpoint valida el holdingId
	async findAll() {
		// ...
	}
}
```

### Acceder al holdingId validado

```typescript
import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { HoldingAccessGuard } from '@/guards/holding-access.guard';

@Controller('odoo/connections')
@UseGuards(HoldingAccessGuard)
export class OdooConnectionController {
	@Get()
	async findAll(@Request() req) {
		// El holdingId ya está validado y disponible en el request
		const holdingId = req.validatedHoldingId;
		const holdingIdFromHeader = req.headers['x-holding-id'];

		// Ambos son el mismo valor
		console.log(holdingId === holdingIdFromHeader); // true
	}
}
```

## Respuestas de error

### Usuario no autenticado

```json
{
	"statusCode": 401,
	"message": "Usuario no autenticado"
}
```

### Usuario sin acceso al holding

```json
{
	"statusCode": 403,
	"message": "No tienes acceso al holding f6e3cb81-8b4a-451e-8402-573e47688d45. Verifica que tengas los permisos necesarios."
}
```

## Integración con el frontend

El frontend envía automáticamente el `holdingId` en el header `X-Holding-Id` a través del `NestJSApiClient`:

```typescript
// Frontend: src/lib/nestjsApi.ts
// El holdingId se agrega automáticamente desde el holdingStore
const holdingId = holdingStore.getHoldingId();
if (holdingId) {
	headers['X-Holding-Id'] = holdingId;
}
```

## Consideraciones

1. **Orden de guards**: Siempre aplicar `SupabaseAuthGuard` antes de `HoldingAccessGuard`
2. **Header opcional**: Si no se envía el header `X-Holding-Id`, el guard permite el acceso (puedes cambiar este comportamiento en el código)
3. **Performance**: El guard realiza una consulta a la base de datos por cada request. Considera implementar caché si es necesario
4. **Super admins**: Los super admins pueden tener acceso a múltiples holdings. El guard valida que tengan al menos uno asociado

## Ejemplo completo

```typescript
import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingAccessGuard } from '@/guards/holding-access.guard';

import { OdooConnectionService } from './odoo-connection.service';
import { CreateOdooConnectionDto } from './dtos/odoo-connection.dto';

@ApiTags('Odoo Connections')
@Controller('odoo/connections')
@UseGuards(SupabaseAuthGuard, HoldingAccessGuard) // Validar autenticación y acceso al holding
@ApiBearerAuth()
export class OdooConnectionController {
	constructor(private readonly odooConnectionService: OdooConnectionService) {}

	@Get()
	async findAll(@Request() req) {
		// El holdingId ya está validado
		const holdingId = req.validatedHoldingId;
		return await this.odooConnectionService.findByHoldingId(holdingId);
	}

	@Post()
	async create(@Request() req, @Body() createDto: CreateOdooConnectionDto) {
		// Usar el holdingId validado para crear la conexión
		const holdingId = req.validatedHoldingId;
		return await this.odooConnectionService.create({
			...createDto,
			holding_id: holdingId,
		});
	}
}
```

## Archivos relacionados

-   **Guard**: `src/guards/holding-access.guard.ts`
-   **Módulo**: `src/guards/guards.module.ts`
-   **Frontend Store**: `sapira-ai/src/lib/holdingStore.ts`
-   **Frontend API Client**: `sapira-ai/src/lib/nestjsApi.ts`
