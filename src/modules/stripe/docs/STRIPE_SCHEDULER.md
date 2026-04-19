# Stripe Scheduler - Sincronización Automática Diaria

## Descripción

El `StripeScheduler` ejecuta automáticamente la sincronización completa de datos de Stripe cada día a una hora configurada. Sincroniza los últimos 2 días de datos para asegurar que cualquier actualización reciente se capture.

## Configuración

### Variables de Entorno

Agrega estas variables a tu archivo `.env`:

```bash
# Habilitar/deshabilitar sincronización automática
STRIPE_SYNC_ENABLED=true

# Hora del día para ejecutar la sincronización (formato 24h)
STRIPE_SYNC_HOUR=2
```

### Valores por Defecto

-   `STRIPE_SYNC_ENABLED`: `true` (activado por defecto)
-   `STRIPE_SYNC_HOUR`: `2` (2:00 AM)

## Funcionamiento

### Proceso de Sincronización

El scheduler ejecuta un proceso de 2 fases:

#### Fase 1: Ingesta (Stripe → Staging)

1. Busca todas las conexiones activas de Stripe
2. Para cada conexión:
    - Calcula el rango de fechas (últimos 2 días)
    - Sincroniza datos desde Stripe API a tablas staging:
        - `stripe_customers_stg`
        - `stripe_subscriptions_stg`
        - `stripe_invoices_stg`

#### Fase 2: Sincronización (Staging → Tablas Principales)

1. Procesa datos desde staging a tablas principales:
    - `customers` → `clients` y `client_entities`
    - `subscriptions` → `subscriptions` y `subscription_items`
    - `invoices` → `invoices` y `invoice_items`

### Características

-   ✅ **No duplica datos**: Los registros existentes se actualizan, no se duplican
-   ✅ **Ventana de 2 días**: Captura actualizaciones recientes de Stripe
-   ✅ **Multi-holding**: Sincroniza todas las conexiones activas automáticamente
-   ✅ **Reintentos automáticos**: Maneja errores y continúa con otras conexiones
-   ✅ **Logging detallado**: Registra todo el proceso para debugging

### Protecciones

-   **Lock de ejecución**: Solo permite una sincronización a la vez
-   **Timeout de ingesta**: 30 minutos máximo
-   **Timeout de sync**: 60 minutos máximo
-   **Manejo de errores**: Continúa con otras conexiones si una falla

## Logs

El scheduler genera logs detallados:

```
🚀 Iniciando sincronización automática de Stripe...
Encontradas 1 conexión(es) activa(s) de Stripe

┌─────────────────────────────────────────────────────────────┐
│  Sincronizando conexión: Production Stripe                  │
│  Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6           │
└─────────────────────────────────────────────────────────────┘

📅 Sincronizando datos desde 2026-04-17 hasta 2026-04-19
📥 Fase 1: Ingesta de datos desde Stripe a staging...
✓ Ingesta completada - Batch ID: abc-123-def
📤 Fase 2: Sincronización de staging a tablas principales...
✓ Sincronización iniciada - Job ID: xyz-789
✓ Sincronización completa finalizada exitosamente
✓ Conexión Production Stripe sincronizada exitosamente

✓ Sincronización completada exitosamente en 45.32s
```

## Monitoreo

### Verificar Estado

Puedes verificar el estado del scheduler en los logs de la aplicación:

```bash
# Ver logs en tiempo real
pm2 logs api-sapira-ai

# Buscar logs del scheduler
pm2 logs api-sapira-ai | grep StripeScheduler
```

### Verificar Última Sincronización

Consulta la tabla `stripe_connections` para ver `last_sync_at`:

```sql
SELECT
  name,
  holding_id,
  is_active,
  last_sync_at
FROM stripe_connections
WHERE is_active = true;
```

## Desactivar Sincronización Automática

Para desactivar temporalmente:

```bash
# En .env
STRIPE_SYNC_ENABLED=false
```

Luego reinicia la aplicación:

```bash
pm2 restart api-sapira-ai
```

## Sincronización Manual

Si necesitas ejecutar una sincronización manual, usa el endpoint:

```bash
POST /stripe/sync
Headers:
  x-holding-id: {holding_id}
Body:
{
  "batchSize": 100
}
```

## Troubleshooting

### El scheduler no se ejecuta

1. Verifica que `STRIPE_SYNC_ENABLED=true`
2. Verifica que hay conexiones activas en `stripe_connections`
3. Revisa los logs para errores

### Sincronización tarda mucho

-   Aumenta el `batchSize` en el código (línea 125 de `stripe.scheduler.ts`)
-   Verifica la velocidad de respuesta de Stripe API
-   Considera reducir la ventana de días si hay muchos datos

### Errores de timeout

-   Los timeouts están configurados para:
    -   Ingesta: 30 minutos
    -   Sync: 60 minutos
-   Si necesitas más tiempo, ajusta los valores en el código

## Arquitectura

```
┌─────────────────┐
│  StripeScheduler│
│   (Cron Job)    │
└────────┬────────┘
         │
         ├─► StripeIngestionService
         │   └─► Stripe API → staging tables
         │
         └─► StripeSyncService
             └─► staging tables → main tables
```

## Próximos Pasos

1. Configura las variables de entorno
2. Reinicia la aplicación
3. Verifica los logs a la hora configurada
4. Monitorea la primera ejecución
5. Ajusta la hora según tus necesidades

## Notas Importantes

-   ⚠️ **Producción**: Asegúrate de que la hora configurada no coincida con períodos de alto tráfico
-   ⚠️ **Zona horaria**: La hora se basa en la zona horaria del servidor
-   ⚠️ **Recursos**: La sincronización puede consumir recursos, monitorea el servidor
-   ✅ **Idempotencia**: Es seguro ejecutar múltiples veces, no duplica datos
