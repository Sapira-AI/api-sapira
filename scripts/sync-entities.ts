import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { IntegrationLog } from '../src/databases/postgresql/entities/integration-log.entity';

// Cargar variables de entorno
config();

/**
 * Script para sincronizar entidades con Supabase
 * Uso: yarn ts-node scripts/sync-entities.ts
 */
async function syncEntities() {
	console.log('🚀 Iniciando sincronización de entidades con Supabase...');

	try {
		// Obtener URL de Supabase directamente del .env
		const supabaseUrl = process.env.SUPABASE_DATABASE_URL;

		if (!supabaseUrl) {
			throw new Error('SUPABASE_DATABASE_URL no está configurada en .env');
		}

		console.log('📋 Conectando a Supabase...');

		// Crear conexión directa a la base de datos
		const dataSource = new DataSource({
			type: 'postgres',
			url: supabaseUrl,
			entities: [IntegrationLog],
			synchronize: false,
			logging: true,
			ssl: {
				rejectUnauthorized: false,
			},
		});

		await dataSource.initialize();
		console.log('✅ Conexión establecida');

		// Sincronizar esquema de entidades
		console.log('🔄 Sincronizando esquema de entidades...');

		// Generar y ejecutar migraciones
		await dataSource.synchronize();

		console.log('✅ Entidades sincronizadas exitosamente');

		// Verificar que la tabla existe
		const queryRunner = dataSource.createQueryRunner();

		try {
			const tableExists = await queryRunner.hasTable('integration_logs');
			console.log(`📊 Tabla integration_logs existe: ${tableExists}`);

			if (tableExists) {
				// Obtener información de la tabla
				const table = await queryRunner.getTable('integration_logs');
				console.log('📋 Columnas de la tabla:');
				table?.columns.forEach((column) => {
					console.log(`  - ${column.name}: ${column.type} ${column.isNullable ? '(nullable)' : '(not null)'}`);
				});

				// Verificar índices usando consulta SQL directa
				const indices = await queryRunner.query(`
					SELECT 
						indexname as name,
						indexdef as definition
					FROM pg_indexes 
					WHERE tablename = 'integration_logs' 
					  AND schemaname = 'public'
					ORDER BY indexname
				`);
				console.log('🔍 Índices encontrados:');
				indices.forEach((index) => {
					const isUnique = index.definition.includes('UNIQUE') ? '(unique)' : '';
					console.log(`  - ${index.name}: ${index.definition} ${isUnique}`);
				});
			}
		} finally {
			await queryRunner.release();
		}

		await dataSource.destroy();

		console.log('🎉 Sincronización completada exitosamente');
	} catch (error) {
		console.error('❌ Error durante la sincronización:', error);
		process.exit(1);
	}
}

// Ejecutar script
if (require.main === module) {
	syncEntities();
}

export { syncEntities };
