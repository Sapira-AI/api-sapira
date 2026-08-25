import dataSource from '../src/databases/postgresql/data-source';
import { resolveSchemaSynchronization } from '../src/databases/postgresql/typeorm-options';

/**
 * Compatibilidad temporal: sincroniza el esquema TypeORM con las mismas
 * guardas de entorno que usa la aplicación. Para inspeccionar cambios sin
 * escribir, usar `yarn schema:log`.
 */
async function syncEntities() {
	try {
		if (!resolveSchemaSynchronization(process.env)) {
			throw new Error('TYPEORM_SCHEMA_SYNC=true es obligatorio para ejecutar schema:sync.');
		}

		await dataSource.initialize();
		await dataSource.synchronize();
		console.log('✅ Esquema TypeORM sincronizado.');
	} catch (error) {
		console.error('❌ Error durante la sincronización:', error);
		process.exit(1);
	} finally {
		if (dataSource.isInitialized) await dataSource.destroy();
	}
}

// Ejecutar script
if (require.main === module) {
	syncEntities();
}

export { syncEntities };
