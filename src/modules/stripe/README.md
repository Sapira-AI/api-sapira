# Módulo Stripe

Este módulo proporciona integración con Stripe para consultar invoices emitidas.

## Configuración

### Variables de Entorno

Agrega las siguientes variables a tu archivo `.env`:

```env
STRIPE_SECRET_KEY=tu_stripe_secret_key_aqui
STRIPE_API_KEY_ID=tu_stripe_api_key_id_aqui
```

## Endpoints Disponibles

### Invoices

#### 1. Obtener Listado de Invoices

**GET** `/stripe/invoices`

Obtiene un listado de invoices de Stripe con opciones de filtrado y paginación.

**Query Parameters:**

-   `customer` (opcional): ID del cliente en Stripe
-   `status` (opcional): Estado de las facturas (draft, open, paid, uncollectible, void)
-   `limit` (opcional): Número de resultados (1-100, default: 10)
-   `starting_after` (opcional): ID del último objeto para paginación

**Ejemplo:**

```bash
GET /stripe/invoices?status=paid&limit=20
```

#### 2. Obtener Invoice por ID

**GET** `/stripe/invoices/:invoice_id`

Obtiene los detalles completos de una invoice específica.

**Path Parameters:**

-   `invoice_id`: ID de la factura en Stripe

**Ejemplo:**

```bash
GET /stripe/invoices/in_123456789
```

#### 3. Obtener Invoices de un Cliente

**GET** `/stripe/customers/:customer_id/invoices`

Obtiene todas las invoices asociadas a un cliente específico.

**Path Parameters:**

-   `customer_id`: ID del cliente en Stripe

**Query Parameters:**

-   `limit` (opcional): Número de resultados

**Ejemplo:**

```bash
GET /stripe/customers/cus_123456789/invoices?limit=10
```

### Clientes

#### 4. Obtener Listado de Clientes

**GET** `/stripe/customers`

Obtiene un listado de clientes registrados en Stripe con opciones de filtrado y paginación.

**Query Parameters:**

-   `email` (opcional): Email del cliente
-   `limit` (opcional): Número de resultados (1-100, default: 10)
-   `starting_after` (opcional): ID del último objeto para paginación

**Ejemplo:**

```bash
GET /stripe/customers?email=cliente@example.com&limit=20
```

#### 5. Obtener Cliente por ID

**GET** `/stripe/customers/:customer_id`

Obtiene los detalles completos de un cliente específico.

**Path Parameters:**

-   `customer_id`: ID del cliente en Stripe

**Ejemplo:**

```bash
GET /stripe/customers/cus_123456789
```

### Suscripciones

#### 6. Obtener Listado de Suscripciones

**GET** `/stripe/subscriptions`

Obtiene un listado de suscripciones en Stripe con opciones de filtrado y paginación.

**Query Parameters:**

-   `customer` (opcional): ID del cliente en Stripe
-   `status` (opcional): Estado de las suscripciones (active, past_due, unpaid, canceled, incomplete, incomplete_expired, trialing, all, ended)
-   `price` (opcional): ID del precio
-   `limit` (opcional): Número de resultados (1-100, default: 10)
-   `starting_after` (opcional): ID del último objeto para paginación

**Ejemplo:**

```bash
GET /stripe/subscriptions?status=active&customer=cus_123456789&limit=20
```

#### 7. Obtener Suscripción por ID

**GET** `/stripe/subscriptions/:subscription_id`

Obtiene los detalles completos de una suscripción específica.

**Path Parameters:**

-   `subscription_id`: ID de la suscripción en Stripe

**Ejemplo:**

```bash
GET /stripe/subscriptions/sub_123456789
```

#### 8. Obtener Suscripciones de un Cliente

**GET** `/stripe/customers/:customer_id/subscriptions`

Obtiene todas las suscripciones asociadas a un cliente específico.

**Path Parameters:**

-   `customer_id`: ID del cliente en Stripe

**Query Parameters:**

-   `limit` (opcional): Número de resultados

**Ejemplo:**

```bash
GET /stripe/customers/cus_123456789/subscriptions?limit=10
```

## Estructura del Módulo

```
stripe/
├── dtos/
│   ├── get-invoices.dto.ts              # DTO para listar invoices
│   ├── get-invoice-by-id.dto.ts         # DTO para obtener invoice por ID
│   ├── get-customers.dto.ts             # DTO para listar clientes
│   ├── get-customer-by-id.dto.ts        # DTO para obtener cliente por ID
│   ├── get-subscriptions.dto.ts         # DTO para listar suscripciones
│   └── get-subscription-by-id.dto.ts    # DTO para obtener suscripción por ID
├── interfaces/
│   ├── stripe-invoice.interface.ts      # Interfaces de invoices
│   ├── stripe-customer.interface.ts     # Interfaces de clientes
│   └── stripe-subscription.interface.ts # Interfaces de suscripciones
├── stripe.controller.ts                 # Controlador con 8 endpoints
├── stripe.module.ts                     # Módulo de NestJS
├── stripe.provider.ts                   # Provider del cliente Stripe
├── stripe.service.ts                    # Servicio con lógica de negocio
└── README.md                            # Documentación

```

## Autenticación

Todos los endpoints requieren autenticación mediante Bearer Token (Supabase Auth).

## Respuestas

### Invoice Object

```typescript
{
  id: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  customer: string;
  customer_email?: string;
  customer_name?: string;
  description?: string;
  hosted_invoice_url?: string;
  invoice_pdf?: string;
  number?: string;
  status: string;
  created: number;
  due_date?: number;
  period_start: number;
  period_end: number;
  lines: {
    data: InvoiceLineItem[];
  };
}
```

### Customer Object

```typescript
{
  id: string;
  email?: string;
  name?: string;
  phone?: string;
  description?: string;
  balance: number;
  created: number;
  currency?: string;
  delinquent: boolean;
  metadata: Record<string, string>;
  address?: {
    city?: string;
    country?: string;
    line1?: string;
    line2?: string;
    postal_code?: string;
    state?: string;
  };
}
```

### Subscription Object

```typescript
{
  id: string;
  customer: string;
  status: string;
  currency: string;
  current_period_start: number;
  current_period_end: number;
  created: number;
  cancel_at_period_end: boolean;
  canceled_at?: number;
  ended_at?: number;
  trial_start?: number;
  trial_end?: number;
  items: {
    data: SubscriptionItem[];
  };
  metadata: Record<string, string>;
}
```

## Uso en Otros Módulos

Para usar el servicio de Stripe en otros módulos:

```typescript
import { StripeModule } from '@/modules/stripe/stripe.module';
import { StripeService } from '@/modules/stripe/stripe.service';

@Module({
	imports: [StripeModule],
})
export class OtroModule {
	constructor(private readonly stripeService: StripeService) {}

	async ejemploInvoices() {
		const invoices = await this.stripeService.getInvoices({ limit: 10 });
	}

	async ejemploClientes() {
		const customers = await this.stripeService.getCustomers({ limit: 20 });
		const customer = await this.stripeService.getCustomerById({ customer_id: 'cus_123' });
	}

	async ejemploSuscripciones() {
		const subscriptions = await this.stripeService.getSubscriptions({
			status: 'active',
			limit: 10,
		});
		const subscription = await this.stripeService.getSubscriptionById({
			subscription_id: 'sub_123',
		});
	}
}
```
