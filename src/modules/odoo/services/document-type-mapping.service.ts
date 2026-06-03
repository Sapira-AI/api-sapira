import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OdooConnection } from '../entities/odoo-connection.entity';
import { OdooProvider } from '../odoo.provider';

interface DocumentTypeMapping {
	code: string;
	odoo_id: number;
	name: string;
}

@Injectable()
export class DocumentTypeMappingService {
	private readonly logger = new Logger(DocumentTypeMappingService.name);
	private cache: Map<string, Map<string, DocumentTypeMapping>> = new Map();

	constructor(
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		private readonly odooProvider: OdooProvider
	) {}

	async getOdooDocumentTypeId(holdingId: string, documentCode: string): Promise<number | null> {
		const cacheKey = `${holdingId}`;
		if (this.cache.has(cacheKey)) {
			const holdingCache = this.cache.get(cacheKey)!;
			if (holdingCache.has(documentCode)) {
				return holdingCache.get(documentCode)!.odoo_id;
			}
		}

		await this.loadDocumentTypes(holdingId);

		if (this.cache.has(cacheKey)) {
			const holdingCache = this.cache.get(cacheKey)!;
			if (holdingCache.has(documentCode)) {
				return holdingCache.get(documentCode)!.odoo_id;
			}
		}

		this.logger.warn(`No se encontró mapeo para código "${documentCode}" en Odoo (holding: ${holdingId})`);
		return null;
	}

	private async loadDocumentTypes(holdingId: string): Promise<void> {
		try {
			const connection = await this.odooConnectionRepository.findOne({
				where: { holding_id: holdingId, is_active: true },
			});

			if (!connection) {
				throw new Error(`No se encontró conexión activa de Odoo para holding ${holdingId}`);
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			const documentTypes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'l10n_latam.document.type',
				'search_read',
				[[]],
				{ fields: ['id', 'code', 'name', 'internal_type'] },
			]);

			const cacheKey = `${holdingId}`;
			const holdingCache = new Map<string, DocumentTypeMapping>();

			for (const docType of documentTypes) {
				const mapping: DocumentTypeMapping = {
					code: docType.code,
					odoo_id: docType.id,
					name: docType.name,
				};
				holdingCache.set(docType.code, mapping);
			}

			this.cache.set(cacheKey, holdingCache);

			this.logger.log(`✅ Cargados ${documentTypes.length} tipos de documento de Odoo para holding ${holdingId}`);
		} catch (error) {
			this.logger.error(`Error cargando tipos de documento de Odoo: ${error.message}`, error.stack);
			throw error;
		}
	}

	clearCache(holdingId?: string): void {
		if (holdingId) {
			this.cache.delete(`${holdingId}`);
			this.logger.log(`Cache limpiado para holding ${holdingId}`);
		} else {
			this.cache.clear();
			this.logger.log('Cache completo limpiado');
		}
	}
}
