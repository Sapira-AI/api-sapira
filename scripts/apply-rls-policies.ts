import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '@/app.module';
import { RLSConfigurations } from '@/databases/postgresql/configs/rls-configurations';
import { GenericRLSService } from '@/databases/postgresql/services/generic-rls.service';

async function applyRLSPolicies() {
	console.log('🔒 Iniciando aplicación de políticas RLS...');

	try {
		const app = await NestFactory.createApplicationContext(AppModule);
		const dataSource = app.get(DataSource);

		// Crear servicio RLS genérico
		const rlsService = new GenericRLSService(dataSource);

		// Registrar todas las configuraciones
		RLSConfigurations.registerAllConfigurations(rlsService);

		// Mostrar tablas configuradas
		const configuredTables = rlsService.getConfiguredTables();
		console.log(`📋 Tablas configuradas: ${configuredTables.join(', ')}`);

		// Aplicar políticas para tabla específica o todas
		const targetTable = process.argv[2]; // Parámetro opcional

		if (targetTable) {
			console.log(`🎯 Aplicando políticas RLS solo para: ${targetTable}`);
			await rlsService.applyTablePolicies(targetTable);

			// Verificar políticas aplicadas
			const policies = await rlsService.checkTablePoliciesStatus(targetTable);
			console.log(`📊 Políticas activas en ${targetTable}:`);
			policies.forEach((policy) => {
				console.log(`  - ${policy.policyname}: ${policy.cmd} (${policy.permissive})`);
			});
		} else {
			console.log('🌐 Aplicando políticas RLS para todas las tablas...');
			await rlsService.applyAllTablePolicies();
		}

		await app.close();
		console.log('🎉 Políticas RLS aplicadas exitosamente');
	} catch (error) {
		console.error('❌ Error aplicando políticas RLS:', error);
		process.exit(1);
	}
}

// Ejecutar script
if (require.main === module) {
	applyRLSPolicies();
}

export { applyRLSPolicies };
