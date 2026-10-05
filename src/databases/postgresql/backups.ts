/**
 * Esquema donde las migraciones de datos guardan el respaldo de lo que cambian (fuera de `public`: no es una tabla del modelo, no la ve
 * la API de datos de Supabase y `database.module.spec.ts` no le exige entity). Una sola constante para todas las migraciones que respaldan
 * (`1791200000000-InvoiceSystemAmountsFromInvoiceCurrency`, `1791500000000-LimpiaPromediosMensualesManuales`, `1791600000000-ConsumosDesdeQuantities`,
 * `1791700000000-PreciosMedidosSimpliRoute`): si Domi confirma otro
 * nombre, se cambia aquí **antes** de aplicarlas en cualquier entorno (una vez aplicada, el `down()` busca el respaldo con este nombre).
 */
export const BACKUP_SCHEMA = 'sapira_backups';

/** SQL para crear el esquema de respaldo sin permisos para nadie más que el dueño (la conexión de migraciones). */
export const CREATE_BACKUP_SCHEMA_SQL = [`CREATE SCHEMA IF NOT EXISTS ${BACKUP_SCHEMA}`, `REVOKE ALL ON SCHEMA ${BACKUP_SCHEMA} FROM PUBLIC`];
