import { assertConnectionMatchesTarget, extractProjectRef, resolveConnectionEnvironment } from './connection-target';

const PROD_REF = 'hklompkypzqtglprfobu';
const poolerUrl = (ref: string): string => `postgresql://postgres.${ref}:secreto@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
const directUrl = (ref: string): string => `postgresql://postgres:secreto@db.${ref}.supabase.co:5432/postgres`;
const localUrl = 'postgres://postgres:postgres@localhost:5432/sapira';

describe('extractProjectRef', () => {
	it('lee el ref del usuario en conexiones por pooler', () => {
		// El host del pooler es compartido por toda la región: el ref es lo único
		// que distingue un proyecto de otro.
		expect(extractProjectRef(poolerUrl(PROD_REF))).toBe(PROD_REF);
	});

	it('lee el ref del host en conexiones directas', () => {
		expect(extractProjectRef(directUrl(PROD_REF))).toBe(PROD_REF);
	});

	it('no inventa un ref para bases que no son de Supabase', () => {
		expect(extractProjectRef(localUrl)).toBeUndefined();
	});

	it('tolera contraseñas con caracteres que rompen el parser de URL', () => {
		expect(extractProjectRef(`postgresql://postgres.${PROD_REF}:pa ss@word@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`)).toBe(PROD_REF);
	});
});

describe('resolveConnectionEnvironment', () => {
	it('reconoce el proyecto de producción', () => {
		expect(resolveConnectionEnvironment(poolerUrl(PROD_REF), {})).toEqual({ environment: 'production', projectRef: PROD_REF });
	});

	it('trata como local cualquier base que no sea un proyecto Supabase', () => {
		expect(resolveConnectionEnvironment(localUrl, {})).toEqual({ environment: 'local' });
	});

	it('exige declarar un proyecto desconocido en vez de adivinar su rol', () => {
		// NOTAS-ESPEJO documenta dos refs cuyo rol nadie confirmó. Clasificarlos a
		// ciegas sería peor que negarse a operar.
		expect(() => resolveConnectionEnvironment(poolerUrl('abcdefghijklmnop'), {})).toThrow(/no está declarado/);
	});

	it('acepta proyectos declarados en SUPABASE_PROJECT_ENVIRONMENTS', () => {
		const resolved = resolveConnectionEnvironment(poolerUrl('abcdefghijklmnop'), {
			SUPABASE_PROJECT_ENVIRONMENTS: '{"abcdefghijklmnop":"qa"}',
		});

		expect(resolved).toEqual({ environment: 'qa', projectRef: 'abcdefghijklmnop' });
	});

	it('rechaza un SUPABASE_PROJECT_ENVIRONMENTS mal formado', () => {
		expect(() => resolveConnectionEnvironment(poolerUrl('abcdefghijklmnop'), { SUPABASE_PROJECT_ENVIRONMENTS: 'no-es-json' })).toThrow(
			/debe ser un JSON/
		);
	});

	it('rechaza un entorno no permitido en la declaración', () => {
		expect(() =>
			resolveConnectionEnvironment(poolerUrl('abcdefghijklmnop'), { SUPABASE_PROJECT_ENVIRONMENTS: '{"abcdefghijklmnop":"staging"}' })
		).toThrow(/debe ser uno de/);
	});
});

describe('assertConnectionMatchesTarget', () => {
	it('bloquea operar sobre producción declarando otro target', () => {
		// El caso que motiva el módulo: `target` sale de NODE_ENV y por defecto vale
		// 'development', así que sin esta guarda un `--apply` corría contra prod sin
		// ninguna confirmación.
		expect(() => assertConnectionMatchesTarget(poolerUrl(PROD_REF), 'development', {})).toThrow(/no coincide con la conexión/);
		expect(() => assertConnectionMatchesTarget(poolerUrl(PROD_REF), 'qa', {})).toThrow(/production/);
	});

	it('bloquea declarar producción apuntando a otra base', () => {
		// Dejaría el historial del runner escrito en el lugar equivocado.
		expect(() => assertConnectionMatchesTarget(localUrl, 'production', {})).toThrow(/no coincide con la conexión/);
	});

	it('permite producción cuando la conexión es realmente producción', () => {
		expect(assertConnectionMatchesTarget(poolerUrl(PROD_REF), 'production', {})).toEqual({ environment: 'production', projectRef: PROD_REF });
	});

	it('permite una base local para cualquier target que no sea producción', () => {
		expect(assertConnectionMatchesTarget(localUrl, 'qa', {})).toEqual({ environment: 'local' });
		expect(assertConnectionMatchesTarget(localUrl, 'development', {})).toEqual({ environment: 'local' });
	});
});
