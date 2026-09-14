/**
 * Vincula el entorno declarado (`--target`, `NODE_ENV`) con la base a la que
 * realmente se está conectando.
 *
 * Sin esto, `target` es una etiqueta escrita a mano y las guardas de producción
 * no protegen nada: un `.env` apuntando a prod sin `NODE_ENV=production` deja
 * `--apply` corriendo contra producción sin ninguna confirmación.
 *
 * El identificador es el **project ref** de Supabase, no el host: el pooler
 * (`aws-0-<region>.pooler.supabase.com`) es compartido por todos los proyectos
 * de la región, así que el host no distingue prod de dev. El ref viaja en el
 * usuario (`postgres.<ref>`) en conexiones por pooler y en el host
 * (`db.<ref>.supabase.co`) en conexiones directas.
 */

export type SchemaEnvironment = 'production' | 'qa' | 'development' | 'test';

/** Base que no es un proyecto Supabase: scratch local, Docker, CI. */
export const LOCAL_ENVIRONMENT = 'local' as const;

export type ResolvedEnvironment = SchemaEnvironment | typeof LOCAL_ENVIRONMENT;

/**
 * Proyectos Supabase con rol confirmado. Solo se declara aquí lo que está
 * verificado: `entities/NOTAS-ESPEJO.md` documenta que existen otros dos refs
 * cuyo rol nadie confirmó, y clasificarlos a ciegas sería peor que exigir que
 * se declaren.
 */
export const KNOWN_SUPABASE_PROJECTS: Readonly<Record<string, SchemaEnvironment>> = {
	hklompkypzqtglprfobu: 'production',
};

export interface ResolvedConnection {
	environment: ResolvedEnvironment;
	projectRef?: string;
}

/** Extrae el project ref de Supabase de una cadena de conexión, sin exponer credenciales. */
export function extractProjectRef(connectionString: string): string | undefined {
	const { username, hostname } = parseConnection(connectionString);

	// Pooler: postgres.<ref>@aws-0-<region>.pooler.supabase.com
	const fromUser = /^postgres\.([a-z0-9]{16,})$/i.exec(username ?? '')?.[1];
	if (fromUser) return fromUser;

	// Conexión directa: db.<ref>.supabase.co
	return /^db\.([a-z0-9]{16,})\.supabase\.(co|com)$/i.exec(hostname ?? '')?.[1];
}

/**
 * Determina contra qué entorno apunta realmente la conexión.
 *
 * Un ref desconocido no se adivina: hay que declararlo con
 * `SUPABASE_PROJECT_ENVIRONMENTS` (JSON `{"<ref>": "qa"}`) para poder usarlo.
 */
export function resolveConnectionEnvironment(connectionString: string, environment: NodeJS.ProcessEnv = process.env): ResolvedConnection {
	const projectRef = extractProjectRef(connectionString);
	if (!projectRef) return { environment: LOCAL_ENVIRONMENT };

	const declared = { ...KNOWN_SUPABASE_PROJECTS, ...parseDeclaredProjects(environment.SUPABASE_PROJECT_ENVIRONMENTS) };
	const resolved = declared[projectRef];
	if (!resolved) {
		throw new Error(
			`El proyecto Supabase "${projectRef}" no está declarado. Agrégalo a SUPABASE_PROJECT_ENVIRONMENTS ` +
				`(por ejemplo {"${projectRef}":"qa"}) antes de operar contra él.`
		);
	}

	return { environment: resolved, projectRef };
}

/**
 * Aborta si el entorno declarado no coincide con la base real.
 *
 * Cubre los dos errores peligrosos: creer que se apunta a QA estando en prod, y
 * declarar prod apuntando a otra base (que dejaría el historial del runner
 * escrito en el lugar equivocado).
 */
export function assertConnectionMatchesTarget(
	connectionString: string,
	target: string,
	environment: NodeJS.ProcessEnv = process.env
): ResolvedConnection {
	const resolved = resolveConnectionEnvironment(connectionString, environment);
	if (resolved.environment === target) return resolved;

	// Una base local sirve para cualquier target que no sea producción.
	if (resolved.environment === LOCAL_ENVIRONMENT && target !== 'production') return resolved;

	const donde = resolved.projectRef ? `al proyecto Supabase "${resolved.projectRef}" (${resolved.environment})` : 'a una base local';
	throw new Error(
		`--target ${target} no coincide con la conexión: SUPABASE_DATABASE_URL apunta ${donde}. Corrige el target o la cadena de conexión.`
	);
}

function parseDeclaredProjects(raw: string | undefined): Record<string, SchemaEnvironment> {
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('SUPABASE_PROJECT_ENVIRONMENTS debe ser un JSON del tipo {"<project-ref>":"qa"}.');
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('SUPABASE_PROJECT_ENVIRONMENTS debe ser un JSON del tipo {"<project-ref>":"qa"}.');
	}

	const permitidos: SchemaEnvironment[] = ['production', 'qa', 'development', 'test'];
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).map(([ref, value]) => {
			if (typeof value !== 'string' || !permitidos.includes(value as SchemaEnvironment)) {
				throw new Error(`SUPABASE_PROJECT_ENVIRONMENTS["${ref}"] debe ser uno de: ${permitidos.join(', ')}.`);
			}
			return [ref, value as SchemaEnvironment];
		})
	);
}

function parseConnection(connectionString: string): { username?: string; hostname?: string } {
	try {
		const url = new URL(connectionString);
		return { username: decodeURIComponent(url.username), hostname: url.hostname };
	} catch {
		// Contraseñas con caracteres sin escapar rompen el parser de URL.
		const match = /^[a-z+]+:\/\/([^:@/]+)(?::[^@]*)?@([^:/?]+)/i.exec(connectionString);
		return { username: match?.[1], hostname: match?.[2] };
	}
}
