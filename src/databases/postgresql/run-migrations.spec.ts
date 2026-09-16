import { assertMigrationAllowed, parseMigrationArgs } from '../../../scripts/run-migrations';

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
		});
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
