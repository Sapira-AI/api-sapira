/**
 * Integración con Kame (ERP contable chileno): constantes y helpers puros (sin Nest ni base). Spec: `README.md` de este módulo.
 */
import type { KameEnvironment } from '@/databases/postgresql/entities/integraciones/kame/kame-connection.entity';

export type { KameEnvironment };
export { KAME_ENVIRONMENTS } from '@/databases/postgresql/entities/integraciones/kame/kame-connection.entity';

export const KAME_ENVIRONMENT_LABELS: Record<KameEnvironment, string> = { pruebas: 'Pruebas', produccion: 'Producción' };

/** RUT de la empresa de pruebas que entrega Kame («AMBIENTE DE PRUEBAS API»). */
export const KAME_TEST_COMPANY_RUT = '10491356-3';

/** Kame identifica los documentos por nombre, no por el código del SII. */
export const KAME_DOCUMENT_NAMES: Record<number, string> = {
	33: 'Factura Electrónica',
	34: 'Factura Exenta Electrónica',
	56: 'Nota de Débito Electrónica',
	61: 'Nota de Crédito Electrónica',
};
export const KAME_DOCUMENT_TYPES = Object.keys(KAME_DOCUMENT_NAMES).map(Number);

/** Reintentos de un envío con error: espera antes del intento N+1 (después del último se avisa y queda en error). */
export const KAME_RETRY_DELAYS_MS = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000, 24 * 60 * 60_000];
export const KAME_MAX_ATTEMPTS = KAME_RETRY_DELAYS_MS.length + 1;

/** Kame bloquea por IP sobre 180 peticiones por minuto (WAF, responde 403): Sapira se limita antes. */
export const KAME_REQUESTS_PER_MINUTE = 150;

/** RUT sin puntos y con guion, en mayúsculas (`76.007.171-4` → `76007171-4`). */
export function normalizeKameRut(rut: string | null | undefined): string {
	const clean = String(rut ?? '')
		.replace(/[.\s]/g, '')
		.toUpperCase();

	if (!clean) return '';
	if (clean.includes('-')) return clean;

	return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/** RUT con puntos y guion, como lo muestran los ejemplos de Kame (`76007171-4` → `76.007.171-4`). */
export function formatKameRut(rut: string | null | undefined): string {
	const normalized = normalizeKameRut(rut);
	const [body, dv] = normalized.split('-');

	if (!body || !dv) return normalized;

	return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

/**
 * RUT de Kame permitidos en este entorno (`KAME_ALLOWED_RUTS`, separados por coma). Vacío = sin restricción (producción). En QA y local
 * vale la empresa de pruebas: Kame no tiene sandbox y la empresa de pruebas vive en la API de producción, así que este es el resguardo
 * contra escribir en una empresa real desde un entorno que no es producción.
 */
export function allowedKameRuts(raw: string | undefined = process.env.KAME_ALLOWED_RUTS): string[] {
	return (raw ?? '')
		.split(',')
		.map((rut) => normalizeKameRut(rut))
		.filter(Boolean);
}

/**
 * ¿Se puede escribir en esta empresa de Kame desde este entorno? Con lista, solo sus RUT. Sin lista, **solo en producción**
 * (`NODE_ENV=production`): fuera de producción el resguardo falla cerrado, así un QA o un local mal configurado (el local apunta a la
 * base de producción) nunca escribe en una empresa real.
 */
export function isKameRutAllowed(rut: string, allowed: string[] = allowedKameRuts(), nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
	if (allowed.length === 0) return isProductionEnv(nodeEnv);

	return allowed.includes(normalizeKameRut(rut));
}

export const isProductionEnv = (nodeEnv: string | undefined = process.env.NODE_ENV) => (nodeEnv ?? '').toLowerCase().trim() === 'production';

/** Cómo está el resguardo de RUT en este entorno (lo muestra la API para verificar la configuración). */
export function kameRutGuard(
	allowed: string[] = allowedKameRuts(),
	nodeEnv: string | undefined = process.env.NODE_ENV
): 'lista' | 'abierto' | 'cerrado' {
	if (allowed.length > 0) return 'lista';

	return isProductionEnv(nodeEnv) ? 'abierto' : 'cerrado';
}

/** El job automático de envío corre solo con `KAME_EXPORT_JOB_ENABLED=true` (apagado por defecto, a diferencia de los otros jobs). */
export const kameJobEnabled = (raw: string | undefined = process.env.KAME_EXPORT_JOB_ENABLED) => raw === 'true';

/** Últimos 4 caracteres de un secreto (lo único que ve el front). */
export const secretLast4 = (secret: string | null | undefined) => (secret ? secret.slice(-4) : null);

/** Espera antes del próximo intento después de `attempts` intentos fallidos (`null` = no se reintenta más). */
export function nextRetryDelay(attempts: number): number | null {
	return attempts >= KAME_MAX_ATTEMPTS ? null : (KAME_RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? null);
}

/** Primer día del mes de una fecha `YYYY-MM-DD` (o `YYYY-MM`). */
export const monthStartOf = (date: string) => `${date.slice(0, 7)}-01`;
