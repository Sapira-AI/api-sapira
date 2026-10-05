/**
 * Rastreador del rate limit "por quien actúa" para `@Throttle` (invitar: 20 por minuto). El `ThrottlerGuard` global corre **antes** que
 * `SupabaseAuthGuard`, así que aún no hay `req.user`: se toma el `sub` del JWT del header sin verificar la firma. Es seguro como clave de
 * conteo: una petición válida siempre trae su `sub` real, y una con un `sub` inventado la rechaza después `SupabaseAuthGuard` (401).
 * Sin token legible, cae a la IP (comportamiento por defecto del throttler).
 */
export function actorTracker(req: Record<string, any>): string {
	const sub = jwtSubject(req?.headers?.authorization);

	return sub ? `actor:${sub}` : `ip:${String(req?.ip ?? req?.ips?.[0] ?? 'desconocido')}`;
}

export function jwtSubject(header: unknown): string | null {
	if (typeof header !== 'string') return null;
	const token = header.replace(/^Bearer\s+/i, '').trim();
	const payload = token.split('.')[1];

	if (!payload) return null;
	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };

		return typeof decoded.sub === 'string' && decoded.sub.length > 0 && decoded.sub.length <= 128 ? decoded.sub : null;
	} catch {
		return null;
	}
}

/** 20 invitaciones por minuto por persona (contrato §10.1). */
export const INVITE_THROTTLE = { short: { limit: 20, ttl: 60_000, getTracker: actorTracker } };

/**
 * Rastreador por IP real para rutas públicas que llegan por la BFF de Next (`POST /auth/password-recovery`): la API ve la IP del servidor
 * de Next, así que se usa la primera IP de `X-Forwarded-For` (la BFF la envía); si no viene, la IP del socket.
 */
export function forwardedIpTracker(req: Record<string, any>): string {
	const header = req?.headers?.['x-forwarded-for'];
	const raw = Array.isArray(header) ? header[0] : header;
	const first = typeof raw === 'string' ? raw.split(',')[0]?.trim() : '';

	return `ip:${first || String(req?.socket?.remoteAddress ?? req?.ip ?? 'desconocido')}`;
}

/** Recuperar contraseña: 10/min por IP real (la BFF ya limita 3/min); el límite por correo vive en `PasswordRecoveryService`. */
export const RECOVERY_THROTTLE = { short: { limit: 10, ttl: 60_000, getTracker: forwardedIpTracker } };
