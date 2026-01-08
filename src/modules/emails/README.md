# Módulo Emails (SendGrid)

Este módulo gestiona la configuración y envío de emails usando **SendGrid** como proveedor de servicios de email.

## Características

-   ✅ Verificación y registro de dominios en SendGrid
-   ✅ Gestión de registros DNS (CNAME para autenticación)
-   ✅ Validación del estado de verificación del dominio
-   ✅ Envío de emails de prueba
-   ✅ Almacenamiento de configuración por holding

## Estructura del Módulo

```
emails/
├── dtos/
│   ├── check-status.dto.ts
│   ├── get-sender-config.dto.ts
│   ├── send-test-email.dto.ts
│   └── verify-domain.dto.ts
├── interfaces/
│   └── email-sender-config.interface.ts
├── emails.controller.ts
├── emails.module.ts
├── emails.provider.ts
├── emails.service.ts
└── README.md
```

## Configuración

### Variables de Entorno

Agregar la siguiente variable en tu archivo `.env`:

```env
SENDGRID_API_KEY=tu_api_key_de_sendgrid
```

### Base de Datos

Necesitas crear la tabla `holding_email_sender_settings_sg` en PostgreSQL:

```sql
CREATE TABLE holding_email_sender_settings_sg (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  holding_id UUID NOT NULL,
  sender_domain VARCHAR(255) NOT NULL,
  from_name VARCHAR(255) NOT NULL,
  from_email VARCHAR(255) NOT NULL,
  sendgrid_domain_id VARCHAR(50),
  domain_status VARCHAR(20) DEFAULT 'pending',
  domain_dns_records JSONB,
  domain_verified_at TIMESTAMP,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(holding_id)
);
```

## Endpoints

### 1. Obtener Configuración

```
GET /emails/sender-config?holding_id={uuid}
```

### 2. Verificar Dominio

```
POST /emails/verify-domain
Body: {
  "holding_id": "uuid",
  "sender_domain": "mail.tuempresa.com",
  "from_name": "Mi Empresa",
  "from_email": "noreply@mail.tuempresa.com"
}
```

### 3. Verificar Estado

```
POST /emails/check-status
Body: {
  "holding_id": "uuid"
}
```

### 4. Enviar Email de Prueba

```
POST /emails/send-test
Body: {
  "holding_id": "uuid",
  "test_email": "test@example.com"
}
```

## Flujo de Uso

1. **Registrar dominio**: Llamar a `/verify-domain` con los datos del dominio
2. **Configurar DNS**: Usar los registros DNS retornados para configurar en tu proveedor de dominio
3. **Verificar estado**: Llamar a `/check-status` para validar que los DNS estén configurados
4. **Enviar prueba**: Una vez verificado, usar `/send-test` para probar el envío

## Diferencias con el Módulo Email (Resend)

-   Usa **SendGrid** en lugar de Resend
-   Tabla de BD: `holding_email_sender_settings_sg` (vs `holding_email_sender_settings`)
-   Campo: `sendgrid_domain_id` (vs `resend_domain_id`)
-   API endpoints diferentes de SendGrid
-   Estructura de DNS records específica de SendGrid

## Notas Importantes

-   SendGrid requiere configurar 3 registros CNAME (mail_cname, dkim1, dkim2)
-   La verificación puede tardar algunos minutos después de configurar los DNS
-   El dominio debe estar verificado antes de poder enviar emails
