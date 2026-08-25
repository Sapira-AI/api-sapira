import { Injectable, Logger } from '@nestjs/common';

/**
 * Conserva el contrato de los servicios consumidores sin ejecutar DDL al
 * iniciar la API. Las tablas se crean con TypeORM y los datos semilla se
 * aplican mediante `yarn postgres:assets --apply`.
 */
@Injectable()
export class BancoCentralSchemaService {
	private readonly logger = new Logger(BancoCentralSchemaService.name);

	async ensureSchema(): Promise<void> {
		this.logger.debug('El esquema Banco Central se administra fuera del runtime de la API.');
	}
}
