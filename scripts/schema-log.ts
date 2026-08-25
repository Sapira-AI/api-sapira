import dataSource from '../src/databases/postgresql/data-source';

async function logSchemaChanges(): Promise<void> {
	try {
		await dataSource.initialize();
		const sqlInMemory = await dataSource.driver.createSchemaBuilder().log();

		if (sqlInMemory.upQueries.length === 0 && sqlInMemory.downQueries.length === 0) {
			console.log('✅ No hay diferencias de esquema detectadas por TypeORM.');
			return;
		}

		console.log('-- Cambios propuestos por TypeORM (no aplicados)');
		for (const query of sqlInMemory.upQueries) {
			console.log(`${query.query};`);
		}
	} finally {
		if (dataSource.isInitialized) await dataSource.destroy();
	}
}

if (require.main === module) {
	logSchemaChanges().catch((error) => {
		console.error('❌ No fue posible generar el log de esquema:', error);
		process.exit(1);
	});
}

export { logSchemaChanges };
