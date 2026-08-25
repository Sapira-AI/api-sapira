import { createPostgreSqlCliOptions, resolveSchemaSynchronization } from './typeorm-options';

const databaseUrl = 'postgres://user:password@localhost:5432/sapira';

describe('typeorm-options', () => {
	it('mantiene synchronize desactivado por defecto', () => {
		expect(resolveSchemaSynchronization({ SUPABASE_DATABASE_URL: databaseUrl })).toBe(false);
	});

	it('permite synchronize explícito fuera de producción', () => {
		expect(
			resolveSchemaSynchronization({
				SUPABASE_DATABASE_URL: databaseUrl,
				NODE_ENV: 'qa',
				TYPEORM_SCHEMA_SYNC: 'true',
			})
		).toBe(true);
	});

	it('bloquea synchronize en producción sin todas las confirmaciones', () => {
		expect(() =>
			resolveSchemaSynchronization({
				SUPABASE_DATABASE_URL: databaseUrl,
				NODE_ENV: 'production',
				TYPEORM_SCHEMA_SYNC: 'true',
			})
		).toThrow(/TYPEORM_ALLOW_PROD_SYNC/);
	});

	it('permite synchronize en producción solo tras confirmación explícita', () => {
		expect(
			resolveSchemaSynchronization({
				SUPABASE_DATABASE_URL: databaseUrl,
				NODE_ENV: 'production',
				TYPEORM_SCHEMA_SYNC: 'true',
				TYPEORM_ALLOW_PROD_SYNC: 'true',
				TYPEORM_SCHEMA_BACKUP_CONFIRMED: 'true',
				SCHEMA_SYNC_CONFIRMATION: 'production',
			})
		).toBe(true);
	});

	it('expone las entidades y sincronización para el CLI', () => {
		const options = createPostgreSqlCliOptions({ SUPABASE_DATABASE_URL: databaseUrl });

		expect(options.entities).toEqual([expect.stringContaining('*.entity')]);
		expect(options.synchronize).toBe(false);
	});

	it('carga los espejos solo mediante una promoción explícita', () => {
		const options = createPostgreSqlCliOptions({
			SUPABASE_DATABASE_URL: databaseUrl,
			TYPEORM_LOAD_MIRROR_ENTITIES: 'true',
		});

		expect(options.entities?.length).toBeGreaterThan(1);
	});
});
