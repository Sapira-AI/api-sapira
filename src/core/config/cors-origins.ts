const DEFAULT_ORIGINS = 'http://localhost:8080,http://localhost:8081';

/** Separa una lista de orígenes por coma, descartando espacios y vacíos. */
function parseOrigins(value: string | undefined, fallback: string): string[] {
	return (value || fallback)
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/**
 * Orígenes de los fronts declarados en `FRONT_BASE_URL` (separados por coma). Es la URL de los fronts,
 * no la política de CORS: `recaptcha.service.ts` la usa para los hostnames que acepta un captcha.
 */
export function getFrontendOrigins(frontBaseUrl = process.env.FRONT_BASE_URL): string[] {
	return parseOrigins(frontBaseUrl, DEFAULT_ORIGINS);
}

/**
 * Orígenes permitidos por CORS, compartidos por HTTP (`main.ts`) y los dos gateways WebSocket, para que
 * un front que puede llamar a la API también pueda abrir el socket.
 *
 * La lista sale de **`CORS_ORIGINS`**, y solo de ahí: son los orígenes que pueden hacer peticiones con
 * credenciales (`credentials: true`), así que se declaran uno por uno. Si la variable no está definida cae a
 * `FRONT_BASE_URL` por compatibilidad —los entornos desplegados antes del 05-10-2026 no la traen— y `main.ts`
 * avisa al arrancar. Esa caída es una red de seguridad para no dejar la API sin CORS en un despliegue, no el
 * camino esperado: cada entorno debe declarar `CORS_ORIGINS`.
 *
 * Hasta el 05-10-2026 esta lista incluía `/\.vercel\.app$/`, que habilitaba **cualquier** dominio
 * `*.vercel.app` —de cualquiera, no solo de Sapira— a hacer peticiones con credenciales. Se retiró: un
 * preview deploy que necesite hablar con esta API se agrega a `CORS_ORIGINS` del entorno que corresponda.
 */
export function getCorsOrigins(corsOrigins = process.env.CORS_ORIGINS, frontBaseUrl = process.env.FRONT_BASE_URL): string[] {
	return corsOrigins?.trim() ? parseOrigins(corsOrigins, DEFAULT_ORIGINS) : getFrontendOrigins(frontBaseUrl);
}

/** `true` cuando CORS está cayendo a `FRONT_BASE_URL` porque el entorno no declara `CORS_ORIGINS`. */
export function corsOriginsFaltante(corsOrigins = process.env.CORS_ORIGINS): boolean {
	return !corsOrigins?.trim();
}
