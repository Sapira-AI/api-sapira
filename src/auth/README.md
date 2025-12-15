# Autenticación con Supabase

Esta implementación permite validar tokens JWT generados por Supabase en tu backend NestJS.

## Configuración

### Variables de Entorno

Agrega las siguientes variables a tu archivo `.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_JWT_SECRET=your_supabase_jwt_secret_here
```

### Obtener las Credenciales

1. **SUPABASE_URL**: URL de tu proyecto Supabase
2. **SUPABASE_ANON_KEY**: Clave pública anónima de Supabase
3. **SUPABASE_JWT_SECRET**: Secreto JWT de Supabase (se encuentra en Settings > API > JWT Settings)

## Uso en Controladores

### Proteger Rutas

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/strategies/supabase-auth.guard';
import { GetSupabaseUser } from '../decorators/supabase-user.decorator';
import { SupabaseUser } from '../auth/strategies/supabase.strategy';

@Controller('protected')
export class ProtectedController {
	@Get('profile')
	@UseGuards(SupabaseAuthGuard)
	getProfile(@GetSupabaseUser() user: SupabaseUser) {
		return {
			message: 'Perfil del usuario autenticado',
			user: {
				id: user.id,
				email: user.email,
				metadata: user.user_metadata,
			},
		};
	}
}
```

### Uso del Token desde el Frontend

El token debe enviarse en el header `Authorization` con el prefijo `Bearer`:

```javascript
// Ejemplo con fetch
const response = await fetch('/api/protected/profile', {
	headers: {
		Authorization: `Bearer ${supabaseToken}`,
		'Content-Type': 'application/json',
	},
});

// Ejemplo con Supabase client
const {
	data: { session },
} = await supabase.auth.getSession();
if (session) {
	const response = await fetch('/api/protected/profile', {
		headers: {
			Authorization: `Bearer ${session.access_token}`,
			'Content-Type': 'application/json',
		},
	});
}
```

## Estructura del Usuario

El objeto `SupabaseUser` contiene la siguiente información:

```typescript
interface SupabaseUser {
	id: string; // ID único del usuario
	email?: string; // Email del usuario
	user_metadata?: any; // Metadatos del usuario
	app_metadata?: any; // Metadatos de la aplicación
	aud: string; // Audiencia del token
	exp: number; // Timestamp de expiración
	iat: number; // Timestamp de emisión
	iss: string; // Emisor del token
	sub: string; // Subject (mismo que id)
	role?: string; // Rol del usuario
}
```

## Validaciones

El guard automáticamente valida:

-   ✅ Estructura correcta del token JWT
-   ✅ Firma del token usando el JWT Secret
-   ✅ Expiración del token
-   ✅ Audiencia del token (`authenticated`)
-   ✅ Presencia de campos requeridos

## Manejo de Errores

Si el token es inválido, el guard lanzará una excepción `UnauthorizedException` con uno de estos mensajes:

-   `"Configuración de Supabase no encontrada"`
-   `"JWT Secret de Supabase no configurado"`
-   `"Error al validar token"`
-   `"Token inválido"`
-   `"Token expirado"`
-   `"Token de Supabase inválido"`
