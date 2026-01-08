# Módulo Email

Módulo para gestión de configuración de email sender usando Resend API.

## Endpoints

### GET `/email/sender-config`

Obtiene la configuración actual de email para un holding.

**Query params:**

-   `holding_id` (UUID): ID del holding

**Response:**

```typescript
{
  id: string;
  holding_id: string;
  sender_domain: string;
  from_name: string;
  from_email: string;
  resend_domain_id: string | null;
  domain_status: 'pending' | 'verified' | 'failed';
  domain_dns_records: DnsRecord[] | null;
  domain_verified_at: string | null;
  created_at: string;
  updated_at: string;
}
```

### POST `/email/verify-domain`

Registra un dominio en Resend y obtiene los DNS records que el cliente debe configurar.

**Body:**

```typescript
{
	sender_domain: string; // ej: mail.tuempresa.com
	from_name: string; // ej: Mi Empresa
	from_email: string; // ej: noreply@mail.tuempresa.com
	holding_id: string; // UUID del holding
}
```

**Response:** EmailSenderConfig con `domain_dns_records` poblado

### POST `/email/check-status`

Verifica el estado del dominio en Resend y actualiza la configuración local.

**Body:**

```typescript
{
	holding_id: string;
}
```

**Response:**

```typescript
{
	status: 'pending' | 'verified' | 'failed';
	config: EmailSenderConfig;
}
```

### POST `/email/send-test`

Envía un email de prueba usando la configuración verificada.

**Body:**

```typescript
{
	test_email: string;
	holding_id: string;
}
```

**Response:**

```typescript
{
  message: string;
  note?: string;
}
```

## Configuración

### Variables de entorno requeridas

```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
```

Obtén tu API key en: https://resend.com/api-keys

## Flujo de uso

1. **Cliente configura dominio** → POST `/email/verify-domain`

    - Sapira llama Resend API
    - Resend genera DNS records únicos
    - Sapira guarda y retorna los DNS records

2. **Cliente configura DNS** → En su proveedor (GoDaddy, Cloudflare, etc.)

    - Agrega los registros TXT, MX provistos

3. **Cliente verifica estado** → POST `/email/check-status`

    - Sapira consulta Resend
    - Resend valida DNS
    - Actualiza estado a 'verified' si todo está correcto

4. **Cliente envía prueba** → POST `/email/send-test`
    - Solo funciona si `domain_status === 'verified'`
    - Envía email de prueba desde la identidad configurada

## Tabla en Supabase

```sql
CREATE TABLE holding_email_sender_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id UUID NOT NULL UNIQUE,
  sender_domain TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  resend_domain_id TEXT,
  domain_status TEXT CHECK (domain_status IN ('pending', 'verified', 'failed')),
  domain_dns_records JSONB,
  domain_verified_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```
