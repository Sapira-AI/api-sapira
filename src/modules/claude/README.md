# Módulo Claude API

Este módulo proporciona integración con Claude API (Anthropic) utilizando el modelo **Claude Sonnet 4.5** para crear conversaciones inteligentes con soporte de skills (herramientas).

## Características

- ✅ Integración con Claude Sonnet 4.5 (`claude-sonnet-4-20250514`)
- ✅ Soporte para conversaciones con contexto
- ✅ Sistema de skills (tools) personalizable
- ✅ Gestión de skills por holding
- ✅ Activación/desactivación de skills
- ✅ Ejecución automática de skills durante conversaciones
- ✅ Autenticación con MSAL (Supabase)

## Configuración

### Variables de Entorno

Agregar en tu archivo `.env`:

```env
ANTHROPIC_API_KEY=tu_api_key_de_anthropic
```

### Base de Datos

Ejecutar el script SQL para crear la tabla de skills:

```bash
psql -U usuario -d database -f scripts/create-claude-skills-table.sql
```

## Estructura del Módulo

```
claude/
├── dtos/
│   ├── send-message.dto.ts      # DTO para enviar mensajes
│   └── create-skill.dto.ts      # DTOs para gestión de skills
├── interfaces/
│   ├── claude-response.interface.ts  # Interfaces de respuesta de Claude
│   └── skill.interface.ts            # Interfaces de skills
├── claude.controller.ts         # Controlador REST
├── claude.service.ts           # Lógica de negocio
├── claude.module.ts            # Módulo NestJS
└── claude.provider.ts          # Providers (vacío por ahora)
```

## Endpoints

### Mensajes

#### POST `/claude/message`
Envía un mensaje a Claude y recibe una respuesta.

**Body:**
```json
{
  "message": "Hola, ¿cómo estás?",
  "conversation_id": "uuid-opcional",
  "system_prompt": "Eres un asistente útil",
  "messages": [
    {
      "role": "user",
      "content": "Mensaje previo"
    }
  ],
  "use_skills": true,
  "holding_id": "uuid-opcional"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "¡Hola! Estoy muy bien, gracias por preguntar...",
    "conversation_id": "uuid",
    "usage": {
      "input_tokens": 150,
      "output_tokens": 200
    }
  }
}
```

### Skills

#### POST `/claude/skills`
Crea una nueva skill.

**Body:**
```json
{
  "name": "get_weather",
  "description": "Obtiene el clima actual de una ciudad",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "Nombre de la ciudad"
      },
      "country": {
        "type": "string",
        "description": "Código del país (opcional)"
      }
    },
    "required": ["city"]
  },
  "holding_id": "uuid-opcional"
}
```

#### GET `/claude/skills`
Lista todas las skills disponibles.

**Query Params:**
- `holding_id` (opcional): Filtra por holding

#### GET `/claude/skills/:skillId`
Obtiene una skill específica.

#### PUT `/claude/skills/:skillId`
Actualiza una skill existente.

**Body:**
```json
{
  "description": "Nueva descripción",
  "input_schema": { /* nuevo schema */ },
  "holding_id": "uuid-opcional"
}
```

#### DELETE `/claude/skills/:skillId`
Elimina una skill.

#### PUT `/claude/skills/:skillId/toggle`
Activa o desactiva una skill.

**Body:**
```json
{
  "is_active": true,
  "holding_id": "uuid-opcional"
}
```

## Uso Programático

### Enviar un mensaje simple

```typescript
import { ClaudeService } from '@/modules/claude/claude.service';

// En tu servicio
constructor(private readonly claudeService: ClaudeService) {}

async example() {
  const result = await this.claudeService.sendMessage(
    '¿Cuál es la capital de Francia?',
    undefined,
    false // sin skills
  );
  
  console.log(result.response);
}
```

### Conversación con contexto

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Hola' },
    { role: 'assistant', content: 'Hola, ¿en qué puedo ayudarte?' }
  ],
  system_prompt: 'Eres un experto en geografía'
};

const result = await this.claudeService.sendMessage(
  '¿Cuál es el río más largo del mundo?',
  context,
  false
);
```

### Crear y usar skills

```typescript
// Crear una skill
await this.claudeService.createSkill(
  'get_user_info',
  'Obtiene información de un usuario',
  {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'ID del usuario' }
    },
    required: ['user_id']
  },
  holdingId
);

// Usar skills en conversación
const result = await this.claudeService.sendMessage(
  'Dame información del usuario 123',
  undefined,
  true, // habilitar skills
  holdingId
);
```

## Implementar Ejecución de Skills

Para implementar la lógica de ejecución de una skill, edita el método `executeSkill` en `claude.service.ts`:

```typescript
private async executeSkill(context: SkillExecutionContext): Promise<SkillExecutionResult> {
  try {
    switch (context.skill_name) {
      case 'get_weather':
        // Implementar lógica para obtener clima
        const weather = await this.weatherService.getWeather(context.parameters.city);
        return {
          success: true,
          data: weather
        };
      
      case 'get_user_info':
        // Implementar lógica para obtener usuario
        const user = await this.userService.findById(context.parameters.user_id);
        return {
          success: true,
          data: user
        };
      
      default:
        return {
          success: false,
          error: `Skill '${context.skill_name}' no implementada`
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
```

## Modelo Utilizado

Este módulo utiliza **Claude Sonnet 4.5** (`claude-sonnet-4-20250514`), que ofrece:

- Alta capacidad de razonamiento
- Soporte nativo para tools/functions
- Respuestas rápidas y precisas
- Contexto de 200K tokens
- Multimodalidad (texto e imágenes)

## Seguridad

- Todos los endpoints requieren autenticación con MSAL (Supabase)
- Las skills pueden ser globales o específicas por holding
- El API key de Anthropic debe mantenerse seguro en variables de entorno

## Próximos Pasos

1. Implementar skills específicas para tu caso de uso
2. Agregar persistencia de conversaciones en base de datos
3. Implementar rate limiting específico para Claude API
4. Agregar métricas y logging de uso
5. Crear helpers para skills comunes
