const DEFAULT_FRONT_BASE_URL = 'http://localhost:8080,http://localhost:8081';

/** Orígenes de los fronts declarados en `FRONT_BASE_URL` (separados por coma). */
export function getFrontendOrigins(frontBaseUrl = process.env.FRONT_BASE_URL): string[] {
	return (frontBaseUrl || DEFAULT_FRONT_BASE_URL)
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/**
 * Orígenes permitidos por CORS, compartidos por HTTP (`main.ts`) y los gateways WebSocket,
 * para que un front que puede llamar a la API también pueda abrir el socket.
 */
export function getCorsOrigins(frontBaseUrl = process.env.FRONT_BASE_URL): (string | RegExp)[] {
	return [/\.vercel\.app$/, ...getFrontendOrigins(frontBaseUrl)];
}
