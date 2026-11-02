import { assertMigrationAllowed, parseMigrationArgs, seleccionarMigraciones } from '../../../scripts/run-migrations';

describe('CLI de migraciones (scripts/run-migrations.ts)', () => {
	it('exige una acción conocida y --target', () => {
		expect(() => parseMigrationArgs(['aplicar', '--target', 'qa'])).toThrow(/run, revert o show/);
		expect(() => parseMigrationArgs(['run'])).toThrow(/Falta --target/);
	});

	it('lee las confirmaciones de producción', () => {
		expect(parseMigrationArgs(['run', '--target', 'production', '--allow-production', '--confirm-target', 'production'])).toEqual({
			accion: 'run',
			target: 'production',
			allowProduction: true,
			confirmTarget: 'production',
			only: [],
		});
	});

	it('--only (repetible) elige qué pendientes aplicar; exige nombre y solo vale con run', () => {
		expect(parseMigrationArgs(['run', '--target', 'qa', '--only', 'A1792500000000', '--only', 'B1792510000000']).only).toEqual([
			'A1792500000000',
			'B1792510000000',
		]);
		expect(() => parseMigrationArgs(['run', '--target', 'qa', '--only', '--target'])).toThrow(/--only requiere el nombre/);
		expect(() => parseMigrationArgs(['show', '--target', 'qa', '--only', 'A1792500000000'])).toThrow(/--only solo aplica a run/);
		// La selección conserva el orden declarado y rechaza un nombre que no existe (nada se aplica a medias).
		class A1 {
			name = 'A1792400000000';
		}
		class B1 {
			name = 'B1792500000000';
		}
		class C1 {
			name = 'C1792510000000';
		}
		const declaradas = [new A1(), new B1(), new C1()];

		expect(seleccionarMigraciones(declaradas, [])).toBe(declaradas);
		expect(seleccionarMigraciones(declaradas, ['C1792510000000', 'B1792500000000']).map((m) => m.name)).toEqual([
			'B1792500000000',
			'C1792510000000',
		]);
		expect(() => seleccionarMigraciones(declaradas, ['X1792520000000'])).toThrow(/desconocida en --only: X1792520000000/);
	});

	it('rechaza una bandera mal escrita en vez de ignorarla', () => {
		// Antes cualquier argumento extra se ignoraba: `--allow-prod` pasaba en silencio.
		expect(() => parseMigrationArgs(['run', '--target', 'production', '--allow-prod'])).toThrow(/no reconocido: --allow-prod/);
	});

	it('run y revert en producción exigen las dos confirmaciones', () => {
		const sinConfirmar = parseMigrationArgs(['run', '--target', 'production']);
		const mediaConfirmacion = parseMigrationArgs(['revert', '--target', 'production', '--allow-production']);
		const confirmado = parseMigrationArgs(['run', '--target', 'production', '--allow-production', '--confirm-target', 'production']);

		expect(() => assertMigrationAllowed(sinConfirmar, 'production')).toThrow(/run en producción requiere/);
		expect(() => assertMigrationAllowed(mediaConfirmacion, 'production')).toThrow(/revert en producción requiere/);
		expect(() => assertMigrationAllowed(confirmado, 'production')).not.toThrow();
	});

	it('show no exige confirmación, y fuera de producción tampoco run', () => {
		expect(() => assertMigrationAllowed(parseMigrationArgs(['show', '--target', 'production']), 'production')).not.toThrow();
		expect(() => assertMigrationAllowed(parseMigrationArgs(['run', '--target', 'qa']), 'qa')).not.toThrow();
	});
});
