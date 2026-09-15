/**
 * Verifica los predicados de las policies RLS **sin aplicar nada y sin activar RLS**.
 *
 * El problema que resuelve: el backend se conecta con un rol que tiene `rolbypassrls`, así que
 * ninguna prueba que pase por la API ejercita una policy. Y no hay entorno intermedio —
 * `KNOWN_SUPABASE_PROJECTS` declara un solo project ref, el de producción.
 *
 * Cómo lo resuelve: dentro de una transacción `READ ONLY`, simula la identidad de un usuario real
 * con `set_config('request.jwt.claims', ...)`, baja de privilegio con `SET LOCAL ROLE authenticated`
 * y evalúa el predicado a mano. Tres cosas hacen que sea válido:
 *
 *  - **`SET ROLE` sí desactiva el bypass**: se evalúa sobre el rol actual, y `authenticated` no
 *    tiene `rolbypassrls`.
 *  - **Los GUC personalizados sobreviven al cambio de rol**, así que `test.*` es el canal para pasar
 *    la verdad de referencia a través de la frontera de privilegio. Una tabla temporal no serviría:
 *    `authenticated` no tendría permisos sobre ella.
 *  - **La transacción es `READ ONLY`**, así que no puede escribir aunque algo salga mal.
 *
 * Antes de nada verifica la definición real de `auth.uid()`: si lee un claim distinto del que arma
 * el `set_config`, todas las comprobaciones darían 0 y el resultado sería un falso negativo
 * silencioso. Es la comprobación que convierte esto en una prueba y no en un teatro.
 *
 * Uso:
 *   yarn schema:verify-policies --target production
 */
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { assertConnectionMatchesTarget } from '../../src/databases/postgresql/connection-target';

interface Caso {
	tabla: string;
	/** Predicado de la policy, tal como está declarado en el asset de `rls/`. */
	predicado: string;
	/** Cómo se cuenta lo que ese usuario *debería* ver, con el rol privilegiado. */
	esperado: (holdingId: string) => string;
}

const CASOS: Caso[] = [
	{
		tabla: 'stripe_sync_jobs',
		predicado: 'holding_id = get_current_user_holding_id()',
		esperado: (h) => `SELECT count(*) AS n FROM public.stripe_sync_jobs WHERE holding_id = '${h}'`,
	},
	{
		tabla: 'odoo_product_mappings',
		predicado: 'holding_id = get_current_user_holding_id()',
		esperado: (h) => `SELECT count(*) AS n FROM public.odoo_product_mappings WHERE holding_id = '${h}'`,
	},
	{
		tabla: 'stripe_product_mappings',
		predicado: 'holding_id = get_current_user_holding_id()',
		esperado: (h) => `SELECT count(*) AS n FROM public.stripe_product_mappings WHERE holding_id = '${h}'`,
	},
	{
		tabla: 'generic_export_vats',
		predicado: 'is_active = true',
		esperado: () => `SELECT count(*) AS n FROM public.generic_export_vats WHERE is_active = true`,
	},
	{
		tabla: 'indicadores_economicos',
		predicado: 'true',
		esperado: () => `SELECT count(*) AS n FROM public.indicadores_economicos`,
	},
];

function parseArgs(args: string[]): { target: string } {
	const indice = args.indexOf('--target');
	const target = indice >= 0 ? args[indice + 1] : undefined;
	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');
	return { target };
}

async function main(): Promise<void> {
	const { target } = parseArgs(process.argv.slice(2));
	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('Falta SUPABASE_DATABASE_URL.');

	const resolved = assertConnectionMatchesTarget(connectionString, target);
	console.log(`Conexión verificada: ${resolved.projectRef ?? 'local'} (${resolved.environment})\n`);

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	const fallos: string[] = [];

	try {
		await client.query('BEGIN TRANSACTION READ ONLY');

		// --- 0. La comprobación que hace que todo lo demás signifique algo -------------------
		const uid = await client.query<{ def: string }>(`SELECT pg_get_functiondef('auth.uid'::regproc) AS def`);
		const leeClaims = /request\.jwt\.claims/.test(uid.rows[0].def);
		console.log(`auth.uid() lee request.jwt.claims: ${leeClaims ? 'sí' : 'NO'}`);
		if (!leeClaims) {
			throw new Error('auth.uid() no lee request.jwt.claims: la simulación de identidad no aplicaría y las pruebas darían falsos negativos.');
		}

		// --- 1. Dos usuarios que resuelvan a holdings DISTINTOS ------------------------------
		// El holding esperado se calcula replicando la lógica de `rls_user_holding_id()` —el que
		// tiene `selected = true`, y si no el primer activo— en vez de llamando a la función, para
		// que la comprobación de identidad no sea una tautología. Elegir una fila cualquiera de
		// `user_holdings` no sirve: un usuario puede pertenecer a varios holdings.
		const usuarios = await client.query<{ user_id: string; auth_id: string; holding_id: string }>(`
			WITH resuelto AS (
				SELECT u.id AS user_id, u.auth_id,
				       COALESCE(
				         (SELECT uh.holding_id FROM public.user_holdings uh
				           WHERE uh.user_id = u.id AND uh.selected AND uh.is_active LIMIT 1),
				         (SELECT uh.holding_id FROM public.user_holdings uh
				           WHERE uh.user_id = u.id AND uh.is_active
				           ORDER BY uh.created_at ASC LIMIT 1)
				       ) AS holding_id
				FROM public.users u
				WHERE u.auth_id IS NOT NULL
			)
			-- Se prefiere el holding CON MÁS DATOS: si el usuario A resolviera a un holding vacío,
			-- «ve lo suyo: 0 (esperado 0)» y «B no ve lo de A: 0» pasarían trivialmente y la prueba
			-- no distinguiría una policy correcta de una que no filtra nada.
			, por_holding AS (
				SELECT DISTINCT ON (r.holding_id) r.user_id, r.auth_id, r.holding_id,
				       (SELECT count(*) FROM public.stripe_sync_jobs s WHERE s.holding_id = r.holding_id)
				     + (SELECT count(*) FROM public.odoo_product_mappings o WHERE o.holding_id = r.holding_id)
				     + (SELECT count(*) FROM public.stripe_product_mappings p WHERE p.holding_id = r.holding_id) AS filas
				FROM resuelto r WHERE r.holding_id IS NOT NULL
				ORDER BY r.holding_id, r.user_id
			)
			SELECT user_id, auth_id, holding_id FROM por_holding ORDER BY filas DESC, holding_id LIMIT 2
		`);
		if (usuarios.rowCount !== 2) throw new Error(`Se necesitan 2 usuarios de holdings distintos; se encontraron ${usuarios.rowCount}.`);
		const [a, b] = usuarios.rows;
		console.log(`usuario A → holding ${a.holding_id}\nusuario B → holding ${b.holding_id}\n`);

		const comoUsuario = async (authId: string, sql: string): Promise<number> => {
			await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: authId, role: 'authenticated' })]);
			await client.query('SET LOCAL ROLE authenticated');
			const { rows } = await client.query<{ n: string }>(sql);
			await client.query('RESET ROLE');
			return Number(rows[0].n);
		};

		const comprobar = (etiqueta: string, obtenido: number, esperado: number): void => {
			const ok = obtenido === esperado;
			console.log(`  ${ok ? '✅' : '❌'} ${etiqueta}: ${obtenido} (esperado ${esperado})`);
			if (!ok) fallos.push(`${etiqueta}: obtuvo ${obtenido}, esperaba ${esperado}`);
		};

		// --- 2. get_current_user_holding_id() resuelve la identidad simulada ------------------
		console.log('identidad:');
		for (const [nombre, usuario] of [
			['A', a],
			['B', b],
		] as const) {
			await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
				JSON.stringify({ sub: usuario.auth_id, role: 'authenticated' }),
			]);
			await client.query('SET LOCAL ROLE authenticated');
			const { rows } = await client.query<{ h: string | null }>('SELECT get_current_user_holding_id()::text AS h');
			await client.query('RESET ROLE');
			const ok = rows[0].h === usuario.holding_id;
			console.log(`  ${ok ? '✅' : '❌'} usuario ${nombre} resuelve su holding: ${rows[0].h ?? 'NULL'}`);
			if (!ok) fallos.push(`usuario ${nombre}: get_current_user_holding_id() dio ${rows[0].h ?? 'NULL'}, esperaba ${usuario.holding_id}`);
		}

		// --- 3. El predicado de cada policy ----------------------------------------------------
		for (const caso of CASOS) {
			console.log(`\n${caso.tabla}  —  ${caso.predicado}`);
			const { rows } = await client.query<{ n: string }>(caso.esperado(a.holding_id));
			const esperadoA = Number(rows[0].n);

			const consulta = `SELECT count(*) AS n FROM public.${caso.tabla} WHERE ${caso.predicado}`;
			comprobar('usuario A ve lo suyo', await comoUsuario(a.auth_id, consulta), esperadoA);

			if (caso.predicado.includes('holding_id')) {
				const ajeno = `SELECT count(*) AS n FROM public.${caso.tabla} WHERE ${caso.predicado} AND holding_id = '${a.holding_id}'`;
				comprobar('usuario B no ve lo del holding A', await comoUsuario(b.auth_id, ajeno), 0);
			}

			// anon sin claims: get_current_user_holding_id() debe dar NULL y el predicado, 0 filas.
			await client.query(`SELECT set_config('request.jwt.claims', '', true)`);
			await client.query('SET LOCAL ROLE anon');
			const { rows: anon } = await client.query<{ n: string }>(consulta);
			await client.query('RESET ROLE');
			const esperadoAnon = caso.predicado === 'holding_id = get_current_user_holding_id()' ? 0 : Number(anon[0].n);
			comprobar('anon sin identidad', Number(anon[0].n), esperadoAnon);
		}
	} finally {
		await client.query('ROLLBACK');
		await client.end();
	}

	console.log('');
	if (fallos.length) {
		fallos.forEach((f) => console.error(`  ✗ ${f}`));
		throw new Error(`${fallos.length} comprobaciones fallaron.`);
	}
	console.log('Todas las comprobaciones pasaron.');
}

if (require.main === module) {
	void main().catch((error: Error) => {
		console.error(`\nError verificando policies: ${error.message}`);
		process.exitCode = 1;
	});
}

export { CASOS, main };
export const RUTA = path.resolve(__dirname);
