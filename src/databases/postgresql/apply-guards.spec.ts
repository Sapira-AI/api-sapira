import { parseArguments } from '../../../scripts/apply-postgresql-assets';

import { assertAssetsCommiteados, assertFiltroExplicito, rutasModificadas } from './apply-guards';
import { checksumSql, SqlAsset } from './assets-runner';

const asset = (ruta: string): SqlAsset => ({ path: ruta, sql: 'SELECT 1;\n', checksum: checksumSql('SELECT 1;\n') });

describe('assertFiltroExplicito', () => {
	it('bloquea --apply sin filtro', () => {
		// El caso real: 23 assets huérfanos en el corpus, 13 de los cuales se aplicaban sin error
		// reactivando comportamiento eliminado a propósito.
		expect(() => assertFiltroExplicito({ mode: 'apply' })).toThrow(/--apply exige --only/);
		expect(() => assertFiltroExplicito({ mode: 'apply', only: [] })).toThrow(/--only/);
	});

	it('acepta --only o --all', () => {
		expect(() => assertFiltroExplicito({ mode: 'apply', only: ['rls/p.sql'] })).not.toThrow();
		expect(() => assertFiltroExplicito({ mode: 'apply', all: true })).not.toThrow();
	});

	it('no exige filtro en plan, dry-run ni baseline', () => {
		for (const mode of ['plan', 'dry-run', 'baseline'] as const) {
			expect(() => assertFiltroExplicito({ mode })).not.toThrow();
		}
	});
});

describe('rutasModificadas', () => {
	it('lee el formato -z, incluidas las rutas con espacios y acentos', () => {
		// 130 archivos de `rls/` tienen espacios en el nombre: con el formato por líneas git los
		// entrecomilla y escapa, y quedarían justo fuera de la comparación.
		const porcelain = [
			' M src/databases/postgresql/functions/a.sql',
			'?? src/databases/postgresql/rls/Users can view x.sql',
			' M src/databases/postgresql/functions/validación.sql',
		].join('\0');

		expect(rutasModificadas(`${porcelain}\0`)).toEqual([
			'src/databases/postgresql/functions/a.sql',
			'src/databases/postgresql/rls/Users can view x.sql',
			'src/databases/postgresql/functions/validación.sql',
		]);
	});

	it('en un renombrado devuelve destino y origen', () => {
		// Los dos son cambios sin commitear: el archivo nuevo y el que desapareció.
		expect(rutasModificadas('R  rls/nuevo.sql\0rls/viejo.sql\0 M functions/a.sql\0')).toEqual([
			'rls/nuevo.sql',
			'rls/viejo.sql',
			'functions/a.sql',
		]);
	});

	it('tolera una salida vacía', () => {
		expect(rutasModificadas('')).toEqual([]);
	});
});

describe('assertAssetsCommiteados', () => {
	const raiz = 'src/databases/postgresql';

	it('bloquea si un asset seleccionado está sin commitear', () => {
		// Lo que pasó el 2026-09-21: el historial quedó con un checksum que no existía en ninguna rama.
		expect(() => assertAssetsCommiteados([`${raiz}/functions/a.sql`], raiz, [asset('functions/a.sql')])).toThrow(
			/sin commitear[\s\S]*functions\/a\.sql/
		);
	});

	it('ignora los cambios fuera de la selección', () => {
		// Editar otro módulo mientras se aplica un asset puntual es legítimo; bloquearlo llevaría a
		// usar --allow-dirty por costumbre.
		expect(() => assertAssetsCommiteados([`${raiz}/functions/otra.sql`, 'src/main.ts'], raiz, [asset('functions/a.sql')])).not.toThrow();
	});

	it('--allow-dirty omite la guarda', () => {
		expect(() => assertAssetsCommiteados([`${raiz}/functions/a.sql`], raiz, [asset('functions/a.sql')], true)).not.toThrow();
	});
});

describe('parseArguments del CLI de assets', () => {
	it('exige --target: ya no se infiere de NODE_ENV', () => {
		// Era el último lugar donde el target se infería; en --plan etiquetaba la corrida en silencio.
		expect(() => parseArguments(['--plan'])).toThrow(/Falta --target/);
	});

	it('lee los modos y las banderas nuevas', () => {
		expect(parseArguments(['--apply', '--target', 'qa', '--only', 'rls/p.sql', '--allow-dirty'])).toEqual({
			mode: 'apply',
			target: 'qa',
			allowProduction: false,
			confirmTarget: undefined,
			only: ['rls/p.sql'],
			all: false,
			allowDirty: true,
		});
		expect(parseArguments(['--apply', '--all', '--target', 'qa']).all).toBe(true);
		expect(parseArguments(['--baseline', '--target', 'production', '--allow-production', '--confirm-target', 'production'])).toMatchObject({
			mode: 'baseline',
			allowProduction: true,
			confirmTarget: 'production',
		});
	});

	it('rechaza un argumento no reconocido en vez de ignorarlo', () => {
		expect(() => parseArguments(['--apply', '--target', 'qa', '--onlyy', 'rls/p.sql'])).toThrow(/no reconocido: --onlyy/);
	});
});
