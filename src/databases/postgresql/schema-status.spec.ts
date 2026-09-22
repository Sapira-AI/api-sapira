import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildCatalog } from '../../../scripts/schema-as-code/fetch-catalog';
import { Catalog, emitirCorpus, emitirSequences } from '../../../scripts/schema-as-code/generate-assets';

import { checksumSql, discoverSqlAssets, SqlAsset, SqlExecutor } from './assets-runner';
import {
	AccionAsset,
	assetsVerificados,
	calcularMigracionesPendientes,
	clasificarAssets,
	compararConCorpusGenerado,
	contarPorAccion,
	leerMigracionesDeclaradas,
	leerMigracionesEjecutadas,
	normalizarSql,
	objetosNoModelados,
} from './schema-status';

const asset = (ruta: string, sql: string): SqlAsset => ({ path: ruta, sql, checksum: checksumSql(sql) });

describe('normalizarSql', () => {
	it('ignora comentarios de línea completa, espacios y comillas en identificadores simples', () => {
		// Los tres casos reales que con igualdad exacta quedaban como DERIVA permanente en prod:
		// una policy con cabecera explicativa y un trigger escrito en varias líneas.
		const aMano = [
			'-- Catálogo global: sin holding_id.',
			'',
			'CREATE TRIGGER "sapira_quantity_imports_set_updated_at"',
			'BEFORE UPDATE',
			'ON "public"."sapira_quantity_imports"',
			'FOR EACH ROW',
			'EXECUTE FUNCTION set_updated_at();',
		].join('\n');
		const generado =
			'CREATE TRIGGER sapira_quantity_imports_set_updated_at BEFORE UPDATE ON public.sapira_quantity_imports FOR EACH ROW EXECUTE FUNCTION set_updated_at();\n';

		expect(normalizarSql(aMano)).toBe(normalizarSql(generado));
	});

	it('conserva las comillas que sí cambian el nombre', () => {
		// "Users can view…" o "MiTabla" no son equivalentes a su versión sin comillas.
		expect(normalizarSql('DROP POLICY "Users can view" ON t;')).toContain('"Users can view"');
		expect(normalizarSql('SELECT * FROM "MiTabla";')).toContain('"MiTabla"');
	});

	it('detecta un cambio real de definición', () => {
		expect(normalizarSql("WHERE code IN ('VIEW_REPORTES', 'VIEW_DOCUMENTACION')")).not.toBe(normalizarSql("WHERE code IN ('VIEW_REPORTES')"));
	});
});

describe('compararConCorpusGenerado', () => {
	const generado = new Map([
		['functions/igual.sql', 'CREATE FUNCTION igual() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\n'],
		['functions/distinta.sql', 'CREATE FUNCTION distinta() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql;\n'],
		['grants/000-table-privileges.sql', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;\n'],
		['rls/solo_en_base.sql', 'CREATE POLICY solo_en_base ON t;\n'],
	]);
	const assets = [
		asset('functions/igual.sql', '-- cabecera escrita a mano\nCREATE FUNCTION igual() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\n'),
		asset('functions/distinta.sql', 'CREATE FUNCTION distinta() RETURNS int AS $$ SELECT 3 $$ LANGUAGE sql;\n'),
		asset('triggers/huerfano.sql', 'CREATE TRIGGER huerfano …;\n'),
		asset('grants/000-table-privileges.sql', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;\n'),
		asset('seed/001-currencies.sql', 'INSERT INTO currencies …;\n'),
	];

	it('clasifica cada asset según lo que genera la base', () => {
		const { porAsset } = compararConCorpusGenerado(assets, generado);

		expect(Object.fromEntries(porAsset)).toEqual({
			'functions/igual.sql': 'igual',
			'functions/distinta.sql': 'distinto',
			'triggers/huerfano.sql': 'sin-contraparte',
			// Aunque coincida byte a byte: el emisor de grants escribe sentencias fijas.
			'grants/000-table-privileges.sql': 'no-verificable',
			'seed/001-currencies.sql': 'no-verificable',
		});
	});

	it('lista los objetos que existen en la base y no tienen asset', () => {
		expect(compararConCorpusGenerado(assets, generado).soloEnBase).toEqual(['rls/solo_en_base.sql']);
	});

	it('solo ofrece para baseline lo verificado como igual', () => {
		expect([...assetsVerificados(compararConCorpusGenerado(assets, generado))]).toEqual(['functions/igual.sql']);
	});
});

describe('clasificarAssets', () => {
	const casos: [string, string, string | undefined, 'igual' | 'distinto' | 'sin-contraparte' | 'no-verificable', AccionAsset][] = [
		// [descripción, ruta, checksum registrado ('=' vigente, 'viejo' otro, undefined sin fila), verificación, acción]
		['registrado y la base coincide', 'functions/f.sql', '=', 'igual', 'APLICADO'],
		['registrado y la base cambió por fuera', 'functions/f.sql', '=', 'distinto', 'DERIVA'],
		['registrado con nombre no generable', 'special-index/i.sql', '=', 'sin-contraparte', 'APLICADO'],
		['registrado, archivo cambiado, fase que converge', 'rls/p.sql', 'viejo', 'distinto', 'REAPLICAR'],
		['registrado, archivo cambiado, fase que no converge', 'types/e.sql', 'viejo', 'distinto', 'BLOQUEADO'],
		['sin registrar y la base ya coincide', 'triggers/t.sql', undefined, 'igual', 'LINEA BASE'],
		['sin registrar y la base difiere', 'functions/f.sql', undefined, 'distinto', 'PENDIENTE'],
		['sin registrar, difiere, fase que no converge', 'special-index/i.sql', undefined, 'distinto', 'NO CONVERGE'],
		['sin registrar y sin el objeto en la base', 'rls/p.sql', undefined, 'sin-contraparte', 'SIN CONTRAPARTE'],
		['sin registrar, grants o seed', 'seed/s.sql', undefined, 'no-verificable', 'NO VERIFICABLE'],
	];

	it.each(casos)('%s', (_descripcion, ruta, registrado, verificacion, esperada) => {
		const a = asset(ruta, 'SELECT 1;\n');
		const historial = new Map(registrado === undefined ? [] : [[ruta, registrado === '=' ? a.checksum : 'viejo']]);

		expect(clasificarAssets([a], historial, { porAsset: new Map([[ruta, verificacion]]), soloEnBase: [] })).toEqual([
			{ path: ruta, accion: esperada },
		]);
	});

	it('sin tabla de historial nada figura como registrado', () => {
		const a = asset('functions/f.sql', 'SELECT 1;\n');
		expect(clasificarAssets([a], null, { porAsset: new Map([[a.path, 'igual']]), soloEnBase: [] })[0].accion).toBe('LINEA BASE');
	});

	it('cuenta por acción, incluidas las que están en cero', () => {
		const conteo = contarPorAccion([
			{ path: 'a', accion: 'APLICADO' },
			{ path: 'b', accion: 'APLICADO' },
			{ path: 'c', accion: 'DERIVA' },
		]);
		expect(conteo.get('APLICADO')).toBe(2);
		expect(conteo.get('DERIVA')).toBe(1);
		expect(conteo.get('PENDIENTE')).toBe(0);
	});
});

describe('objetosNoModelados', () => {
	it('nombra lo que ninguna fase del corpus puede describir', () => {
		// `soloEnBase` no los ve: se deriva de lo que los emisores producen, así que una vista o un
		// procedimiento no tienen contra qué compararse y pasarían inadvertidos.
		const fuera = objetosNoModelados(
			{
				views: [
					{ name: 'invoices_with_net_amounts', kind: 'v' },
					{ name: 'resumen_mensual', kind: 'm' },
				],
				sequences: [{ name: 'invoice_number_seq' }, { name: 'sin_asset_seq' }],
				otherRoutines: [{ name: 'recalcular', kind: 'p' }],
				otherTypes: [{ name: 'rango_fechas', kind: 'r' }],
			},
			new Map([['types/020-sequence-invoice_number_seq.sql', 'CREATE SEQUENCE …']])
		);

		expect(fuera).toEqual([
			{ tipo: 'procedimiento', nombre: 'recalcular' },
			{ tipo: 'rango', nombre: 'rango_fechas' },
			// `invoice_number_seq` NO figura: el emisor ya la produce, así que está cubierta.
			{ tipo: 'secuencia', nombre: 'sin_asset_seq' },
			{ tipo: 'vista', nombre: 'invoices_with_net_amounts' },
			{ tipo: 'vista materializada', nombre: 'resumen_mensual' },
		]);
	});

	it('un catálogo sin esas claves no rompe', () => {
		expect(objetosNoModelados({}, new Map())).toEqual([]);
	});
});

describe('emitirSequences', () => {
	it('emite la secuencia suelta en types/, de forma idempotente y sin el valor actual', () => {
		// El valor actual (`last_value`) es dato, no estado del esquema.
		const generado = emitirSequences({
			sequences: [{ name: 'invoice_number_seq', start: '1', increment: '1', minvalue: '1', maxvalue: '999', cache: '1', cycle: false }],
		} as never);

		const contenido = generado.get('types/020-sequence-invoice_number_seq.sql');
		expect(contenido).toContain('CREATE SEQUENCE IF NOT EXISTS "public"."invoice_number_seq"');
		expect(contenido).toContain('NO CYCLE;');
		expect(contenido).not.toMatch(/last_value|setval/);
	});
});

describe('migraciones', () => {
	const directorio = path.join(__dirname, 'migrations');

	it('sin tabla de migraciones, todas están pendientes', () => {
		expect(calcularMigracionesPendientes(['A1000000000001', 'B1000000000002'], null)).toEqual({
			tablaExiste: false,
			pendientes: ['A1000000000001', 'B1000000000002'],
			sinArchivo: [],
		});
	});

	it('distingue pendientes de ejecutadas sin archivo en el repo', () => {
		expect(calcularMigracionesPendientes(['A1000000000001', 'B1000000000002'], ['A1000000000001', 'Borrada1000000000000'])).toEqual({
			tablaExiste: true,
			pendientes: ['B1000000000002'],
			sinArchivo: ['Borrada1000000000000'],
		});
	});

	it('toda migración declara name igual a su clase, terminado en 13 dígitos', () => {
		// `leerMigracionesDeclaradas` resuelve el nombre como TypeORM (`name ?? constructor.name`) y
		// ordena por el timestamp final. Si una migración declarara otro `name`, `schema:status` y
		// TypeORM discreparían sobre qué está pendiente.
		for (const archivo of fs.readdirSync(directorio).filter((nombre) => nombre.endsWith('.ts'))) {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			for (const Clase of Object.values(require(path.join(directorio, archivo))) as (new () => { name?: string })[]) {
				expect(new Clase().name).toBe(Clase.name);
				expect(Clase.name).toMatch(/\d{13}$/);
			}
		}
	});

	it('lee las migraciones del repo en orden de ejecución', () => {
		const declaradas = leerMigracionesDeclaradas(directorio);
		const timestamps = declaradas.map((nombre) => Number(nombre.slice(-13)));

		expect(declaradas.length).toBe(fs.readdirSync(directorio).filter((nombre) => nombre.endsWith('.ts')).length);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
	});

	it('lee las ejecutadas en solo lectura, y null si la tabla no existe', async () => {
		const consultas: string[] = [];
		const executor = (tablaExiste: boolean): SqlExecutor => ({
			async query(query) {
				consultas.push(query);
				if (query.includes('to_regclass')) return { rows: [{ tabla: tablaExiste ? 'sapira_typeorm_migrations' : null }] };
				return { rows: [{ name: 'A1000000000001' }] };
			},
		});

		await expect(leerMigracionesEjecutadas(executor(false))).resolves.toBeNull();
		await expect(leerMigracionesEjecutadas(executor(true))).resolves.toEqual(['A1000000000001']);
		expect(consultas.every((query) => /^\s*SELECT/i.test(query))).toBe(true);
	});
});

/**
 * Contrato entre las tres piezas: lo que captura `fetch-catalog` lo entienden los emisores de
 * `generate-assets`, y lo que emiten se compara contra archivos reales en disco. Si alguna cambia
 * de forma, esto falla antes de que `--baseline` registre algo equivocado en una base.
 */
describe('contrato fetch-catalog → generate-assets → schema-status', () => {
	const vacio = { columns: [], constraints: [], foreignKeys: [], grants: [], views: [], partitioned: [], server: [{ version_num: '150008' }] };
	const datos = {
		...vacio,
		tables: [{ table: 'demo', rls: true, rls_forced: false, comment: null, rows: 0 }],
		indexes: [
			{
				table: 'demo',
				name: 'demo_busqueda_idx',
				def: 'CREATE INDEX demo_busqueda_idx ON public.demo USING gin (nombre gin_trgm_ops)',
				unique: false,
				primary: false,
			},
		],
		triggers: [
			{
				table: 'demo',
				name: 'demo_touch',
				def: 'CREATE TRIGGER demo_touch BEFORE UPDATE ON public.demo FOR EACH ROW EXECUTE FUNCTION touch()',
			},
		],
		policies: [
			{ table: 'demo', name: 'demo_select', permissive: 'PERMISSIVE', roles: ['authenticated'], cmd: 'SELECT', qual: 'true', with_check: null },
		],
		enums: [{ name: 'estado_demo', label: 'activo' }],
		extensions: [],
		functions: [
			{
				name: 'touch',
				def: 'CREATE OR REPLACE FUNCTION public.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$\n',
				extension: null,
			},
			// Dos sobrecargas de la misma función, una con comentario multilínea y comilla simple:
			// `pg_get_functiondef` no incluye el COMMENT ON, así que se captura y emite aparte.
			{
				name: 'calcular',
				def: 'CREATE OR REPLACE FUNCTION public.calcular(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a $function$\n',
				extension: null,
				comment: "Suma simple.\nNo usa el 'total' del header.",
				identity_args: 'a integer',
			},
			{
				name: 'calcular',
				def: 'CREATE OR REPLACE FUNCTION public.calcular(a integer, b integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a + b $function$\n',
				extension: null,
				comment: null,
				identity_args: 'a integer, b integer',
			},
		],
	};

	let assetsRoot: string;
	beforeEach(() => {
		assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sapira-status-'));
	});
	afterEach(() => fs.rmSync(assetsRoot, { recursive: true, force: true }));

	const escribir = (ruta: string, contenido: string): void => {
		fs.mkdirSync(path.dirname(path.join(assetsRoot, ruta)), { recursive: true });
		fs.writeFileSync(path.join(assetsRoot, ruta), contenido);
	};

	it('verifica archivos reales contra un catálogo construido como lo hace fetch-catalog', () => {
		const generado = emitirCorpus(buildCatalog(datos as never) as Catalog);
		expect([...generado.keys()].sort()).toEqual([
			'functions/calcular.sql',
			'functions/touch.sql',
			'grants/000-table-privileges.sql',
			'rls/demo_select.sql',
			'special-index/demo_busqueda_idx.sql',
			'triggers/demo_touch.sql',
			'types/000-extensions.sql',
			'types/010-enum-estado_demo.sql',
		]);

		// Las sobrecargas van al mismo archivo separadas por `;`, y los COMMENT ON al final —no
		// intercalados—, para que agregarlos a un archivo con cabecera escrita a mano sea append.
		// La comilla simple del comentario se duplica; los saltos de línea se conservan.
		// El orden entre sobrecargas sale de ordenar por la definición (`,` ordena antes que `)`),
		// que es lo que hace estable el archivo entre capturas.
		expect(generado.get('functions/calcular.sql')).toBe(
			'CREATE OR REPLACE FUNCTION public.calcular(a integer, b integer)\n' +
				' RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a + b $function$;\n\n' +
				'CREATE OR REPLACE FUNCTION public.calcular(a integer)\n' +
				' RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT a $function$;\n\n' +
				"COMMENT ON FUNCTION public.\"calcular\"(a integer) IS 'Suma simple.\nNo usa el ''total'' del header.';\n"
		);
		// Sin comentarios el archivo no termina en `;`: ese es el formato histórico del corpus.
		expect(generado.get('functions/touch.sql').endsWith('$function$\n')).toBe(true);

		// El trigger escrito a mano (multilínea, con comillas) coincide; la función cambió; la policy falta.
		escribir(
			'functions/touch.sql',
			'CREATE OR REPLACE FUNCTION public.touch()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NULL; END $function$\n'
		);
		escribir(
			'triggers/demo_touch.sql',
			`-- a mano\n${generado.get('triggers/demo_touch.sql').replace('ON public.demo', '\nON "public"."demo"')}`
		);
		escribir('special-index/demo_busqueda_idx.sql', generado.get('special-index/demo_busqueda_idx.sql'));
		escribir('triggers/huerfano.sql', 'DROP TRIGGER IF EXISTS huerfano ON public.demo;\n');

		const comparacion = compararConCorpusGenerado(discoverSqlAssets(assetsRoot), generado);

		expect(Object.fromEntries(comparacion.porAsset)).toEqual({
			'functions/touch.sql': 'distinto',
			'special-index/demo_busqueda_idx.sql': 'igual',
			'triggers/demo_touch.sql': 'igual',
			'triggers/huerfano.sql': 'sin-contraparte',
		});
		expect(comparacion.soloEnBase).toEqual([
			'functions/calcular.sql',
			'rls/demo_select.sql',
			'types/000-extensions.sql',
			'types/010-enum-estado_demo.sql',
		]);
	});
});
