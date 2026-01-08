# Módulo de Agentes - Sistema de Automatizaciones

Este módulo implementa el sistema de automatizaciones para agentes de cobranza y proforma en NestJS.

## 📋 Descripción

El módulo de agentes permite automatizar el envío de emails para:

-   **Proforma**: Solicitud de referencias/órdenes de compra antes de emitir facturas
-   **Cobranza**: Recordatorios de pago para facturas vencidas con sistema de buckets

**Integración de emails**: Utiliza el módulo `emails` que envía correos electrónicos a través de **SendGrid**.

## 🏗️ Arquitectura

### Estructura de Archivos

```
agents/
├── dtos/                           # Data Transfer Objects
│   ├── approve-run.dto.ts
│   ├── client-config.dto.ts
│   ├── render-email.dto.ts
│   └── run-agent.dto.ts
├── interfaces/                     # Interfaces TypeScript
│   ├── agent.interface.ts
│   ├── email-sender.interface.ts
│   └── run-response.interface.ts
├── processors/                     # Procesadores de lógica de negocio
│   ├── proforma.processor.ts
│   └── collections.processor.ts
├── helpers/                        # Utilidades
│   └── template.helper.ts
├── agents.controller.ts            # Controlador REST
├── agents.service.ts               # Servicio principal
├── agents.provider.ts              # Providers
├── agents.module.ts                # Módulo NestJS
└── README.md
```

## 🔌 Endpoints API

### 1. Ejecutar Agente

```http
POST /agents/:agentId/run
Authorization: Bearer <token>
Content-Type: application/json

{
  "mode": "preview" | "execute"
}
```

**Respuesta:**

```json
{
  "success": true,
  "data": {
    "run_id": "uuid",
    "status": "queued",
    "stats": {
      "messages_created": 5,
      "clients_processed": 3,
      "clients_skipped": 1,
      "errors": 0
    },
    "messages": [...]
  }
}
```

### 2. Aprobar Ejecución

```http
POST /agents/runs/:runId/approve
Authorization: Bearer <token>
```

### 3. Obtener Configuración de Cliente

```http
GET /agents/client-configs/:clientId/:agentType
Authorization: Bearer <token>
```

### 4. Actualizar Configuración de Cliente

```http
PUT /agents/client-configs/:clientId/:agentType
Authorization: Bearer <token>
Content-Type: application/json

{
  "is_enabled": true,
  "config_json": {
    "days_before_issue": 15,
    "email_sender_address_id": "uuid"
  }
}
```

### 5. Listar Configuraciones

```http
GET /agents/client-configs?agent_type=collections
Authorization: Bearer <token>
```

### 6. Renderizar Email (Preview)

```http
POST /agents/render-email
Authorization: Bearer <token>
Content-Type: application/json

{
  "agent_type": "proforma",
  "template": "Estimado {{contact_name}}...",
  "variables": {
    "contact_name": "Juan Pérez"
  }
}
```

## 🔧 Componentes Principales

### AgentsService

Servicio principal que coordina la ejecución de agentes y gestiona configuraciones.

**Métodos principales:**

-   `runAgent()` - Ejecuta un agente en modo preview o execute
-   `approveRun()` - Aprueba y envía mensajes de un run
-   `getClientConfig()` - Obtiene configuración personalizada por cliente
-   `updateClientConfig()` - Actualiza configuración de cliente
-   `listClientConfigs()` - Lista todas las configuraciones
-   `renderEmail()` - Renderiza plantilla de email

### ProformaProcessor

Procesa facturas que requieren referencias antes de emisión.

**Lógica:**

1. Busca facturas con `status = 'Por Emitir'` y `requires_references_for_billing = true`
2. Filtra por rango de días configurado (`days_before_issue`)
3. Verifica configuración por cliente (habilitado/deshabilitado)
4. Genera mensajes para contactos del cliente
5. Crea registros en `reference_requests`

### CollectionsProcessor

Procesa facturas vencidas con sistema de buckets.

**Lógica:**

1. Busca facturas con `status = 'Emitida'` y vencidas
2. Clasifica en buckets según días de vencimiento:
    - Bucket 1: 30+ días (configurable)
    - Bucket 2: 60+ días (configurable)
3. Verifica frecuencia de envío por bucket
4. Genera tabla HTML con facturas vencidas
5. Envía recordatorios según bucket

## 🎨 Sistema de Plantillas

Las plantillas usan sintaxis de variables con doble llave:

```html
<p>Estimado/a {{contact_name}},</p>
<p>{{client_name}} tiene {{invoice_count}} facturas pendientes.</p>
{{invoices_table}}
```

**Variables disponibles:**

**Proforma:**

-   `client_name`
-   `contact_name`
-   `invoice_number`
-   `formatted_date`

**Cobranza:**

-   `client_name`
-   `contact_name`
-   `invoice_count`
-   `total_amount`
-   `invoices_table` (HTML generado)

## ⚙️ Configuración

### Configuración Global (ai_agent_configs)

```json
{
	"days_before_issue": 10,
	"require_approval": true,
	"email_subject_template": "Solicitud de referencia - {{client_name}}",
	"email_body_template": "<p>...</p>"
}
```

### Configuración por Cliente (client_agent_configs)

```json
{
	"is_enabled": true,
	"config_json": {
		"days_before_issue": 15,
		"email_sender_address_id": "uuid",
		"custom_email_subject": "URGENTE: Referencia requerida",
		"custom_email_body": "<p>...</p>"
	}
}
```

**Prioridad:** Configuración de cliente > Configuración global

## 🔐 Autenticación

Todos los endpoints requieren autenticación con Supabase JWT:

```http
Authorization: Bearer <supabase_jwt_token>
```

El `holding_id` se extrae automáticamente del token del usuario.

## 📊 Base de Datos

### Tablas Principales

**ai_agents**

-   Definición de agentes (proforma, collections)

**ai_agent_configs**

-   Configuración global por agente

**ai_runs**

-   Ejecuciones de agentes

**ai_messages**

-   Mensajes generados/enviados

**client_agent_configs**

-   Configuración personalizada por cliente

**reference_requests**

-   Solicitudes de referencias (proforma)

## 🚀 Uso

### Ejemplo: Ejecutar agente de proforma

```typescript
// Preview (sin enviar)
const preview = await fetch('/agents/uuid/run', {
	method: 'POST',
	headers: {
		Authorization: 'Bearer <token>',
		'Content-Type': 'application/json',
	},
	body: JSON.stringify({ mode: 'preview' }),
});

// Ejecutar y enviar
const execute = await fetch('/agents/uuid/run', {
	method: 'POST',
	headers: {
		Authorization: 'Bearer <token>',
		'Content-Type': 'application/json',
	},
	body: JSON.stringify({ mode: 'execute' }),
});
```

### Ejemplo: Configurar cliente

```typescript
// Deshabilitar agente para un cliente
await fetch('/agents/client-configs/client-uuid/collections', {
	method: 'PUT',
	headers: {
		Authorization: 'Bearer <token>',
		'Content-Type': 'application/json',
	},
	body: JSON.stringify({
		is_enabled: false,
	}),
});
```

## 📝 Notas Importantes

1. **Modo Preview**: No envía emails ni crea registros, solo genera vista previa
2. **Modo Execute**: Crea registros y envía emails (si no requiere aprobación)
3. **Frecuencia**: El sistema verifica frecuencia de envío para evitar spam
4. **Configuración por Cliente**: Permite personalizar comportamiento por cliente
5. **Email Sender**: Cada cliente puede tener su propio remitente configurado

## 🔍 Testing

Para probar el módulo:

```bash
# Ejecutar tests unitarios
yarn test agents

# Ejecutar tests e2e
yarn test:e2e agents
```

## 📚 Referencias

-   Documento de arquitectura: `ANALISIS_Y_PROPUESTA_REDISENO.md`
-   Configuración API: `docs/api-nestjs/API_CONFIGURATION_README.md`
