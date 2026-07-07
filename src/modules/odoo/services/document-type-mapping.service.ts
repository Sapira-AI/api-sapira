import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OdooConnection } from '../entities/odoo-connection.entity';
import { OdooProvider } from '../odoo.provider';

interface DocumentTypeMapping {
	code: string;
	odoo_id: number;
	name: string;
	country_name?: string | null;
}

interface DefaultDocumentType {
	id: number;
	code: string;
	name: string;
	internal_type: string;
}

// Códigos de documento permitidos por país (basado en código fuente de Odoo)
// Fuente: l10n_pe/models/account_move.py, l10n_cl/models/account_move.py, etc.
const ALLOWED_INVOICE_CODES_BY_COUNTRY: Record<string, string[]> = {
	PE: ['01', '03', '07', '08', '20', '40'], // Perú - según l10n_pe
	// Agregar otros países según se necesiten
};

@Injectable()
export class DocumentTypeMappingService {
	private readonly logger = new Logger(DocumentTypeMappingService.name);
	private cache: Map<string, Map<string, DocumentTypeMapping[]>> = new Map();
	private defaultDocTypeCache: Map<string, DefaultDocumentType | null> = new Map();

	constructor(
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		private readonly odooProvider: OdooProvider
	) {}

	async getOdooDocumentTypeId(holdingId: string, documentCode: string, countryName?: string): Promise<number | null> {
		const cacheKey = `${holdingId}`;
		const normalizedDocumentCode = this.normalizeDocumentCode(documentCode);
		const normalizedCountryName = this.normalizeCountryName(countryName);

		if (this.cache.has(cacheKey)) {
			const holdingCache = this.cache.get(cacheKey)!;
			const odooId = this.findDocumentTypeIdInCache(holdingCache, normalizedDocumentCode, normalizedCountryName);
			if (odooId) {
				return odooId;
			}
		}

		await this.loadDocumentTypes(holdingId);

		if (this.cache.has(cacheKey)) {
			const holdingCache = this.cache.get(cacheKey)!;
			const odooId = this.findDocumentTypeIdInCache(holdingCache, normalizedDocumentCode, normalizedCountryName);
			if (odooId) {
				return odooId;
			}
		}

		this.logger.warn(
			`No se encontró mapeo para código "${normalizedDocumentCode}" en Odoo (holding: ${holdingId}, país: ${countryName || 'no especificado'})`
		);
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
				{
					fields: ['id', 'code', 'name', 'internal_type', 'active', 'country_id'],
					order: 'code asc',
				},
			]);

			const cacheKey = `${holdingId}`;
			const holdingCache = new Map<string, DocumentTypeMapping[]>();

			for (const docType of documentTypes) {
				const normalizedCode = this.normalizeDocumentCode(docType.code);
				const mapping: DocumentTypeMapping = {
					code: normalizedCode,
					odoo_id: docType.id,
					name: docType.name,
					country_name: Array.isArray(docType.country_id) ? docType.country_id[1] : null,
				};
				const existingMappings = holdingCache.get(normalizedCode) || [];
				holdingCache.set(normalizedCode, [...existingMappings, mapping]);
			}

			this.cache.set(cacheKey, holdingCache);

			this.logger.log(`✅ Cargados ${documentTypes.length} tipos de documento de Odoo para holding ${holdingId}`);
		} catch (error) {
			this.logger.error(`Error cargando tipos de documento de Odoo: ${error.message}`, error.stack);
			throw error;
		}
	}

	private findDocumentTypeIdInCache(
		holdingCache: Map<string, DocumentTypeMapping[]>,
		documentCode: string,
		countryName?: string
	): number | null {
		const candidates = holdingCache.get(documentCode);
		if (!candidates || candidates.length === 0) {
			return null;
		}

		if (countryName) {
			const countryMatch = candidates.find((candidate) => this.normalizeCountryName(candidate.country_name) === countryName);
			if (countryMatch) {
				return countryMatch.odoo_id;
			}
		}

		if (candidates.length > 1) {
			this.logger.warn(
				`Se encontraron múltiples tipos de documento para código "${documentCode}"${countryName ? ` y país "${countryName}"` : ''}. ` +
					`Se usará el primero: ${JSON.stringify(candidates)}`
			);
		}

		return candidates[0].odoo_id;
	}

	private normalizeDocumentCode(documentCode: string | number): string {
		return String(documentCode).trim();
	}

	private normalizeCountryName(countryName?: string | null): string | undefined {
		if (!countryName) {
			return undefined;
		}

		return countryName
			.trim()
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '');
	}

	async getDefaultDocumentTypeForInvoice(
		holdingId: string,
		companyId: number,
		moveType: 'out_invoice' | 'out_refund'
	): Promise<DefaultDocumentType | null> {
		const cacheKey = `${holdingId}:${companyId}:${moveType}`;

		if (this.defaultDocTypeCache.has(cacheKey)) {
			return this.defaultDocTypeCache.get(cacheKey)!;
		}

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

			const company = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'read',
				[[companyId]],
				{ fields: ['country_id'] },
			]);

			if (!company || company.length === 0 || !company[0].country_id) {
				this.logger.warn(`No se pudo obtener el país de la compañía ${companyId}`);
				this.defaultDocTypeCache.set(cacheKey, null);
				return null;
			}

			const countryId = company[0].country_id[0];
			const internalType = moveType === 'out_refund' ? 'credit_note' : 'invoice';

			// Obtener código del país para aplicar filtros específicos
			const countryData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.country',
				'read',
				[[countryId]],
				{ fields: ['code'] },
			]);

			const countryCode = countryData?.[0]?.code || null;

			const allDocumentTypes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'l10n_latam.document.type',
				'search_read',
				[
					[
						['country_id', '=', countryId],
						['internal_type', '=', internalType],
					],
				],
				{ fields: ['id', 'code', 'name', 'internal_type', 'sequence', 'report_name', 'active'] },
			]);

			// VALIDACIÓN: Solo ejecutar lógica de asignación automática para Perú
			if (countryCode !== 'PE') {
				this.logger.log(`ℹ️ País ${countryCode} detectado. No se asignará tipo de documento automáticamente (solo se aplica para Perú)`);
				this.defaultDocTypeCache.set(cacheKey, null);
				return null;
			}

			// Construir filtros base para Perú
			const filters: any[] = [
				['country_id', '=', countryId],
				['internal_type', '=', internalType],
			];

			// Agregar filtro de códigos permitidos para Perú
			if (ALLOWED_INVOICE_CODES_BY_COUNTRY[countryCode]) {
				filters.push(['code', 'in', ALLOWED_INVOICE_CODES_BY_COUNTRY[countryCode]]);
				this.logger.debug(`Aplicando filtro de códigos para ${countryCode}: [${ALLOWED_INVOICE_CODES_BY_COUNTRY[countryCode].join(', ')}]`);
			}

			const documentTypes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'l10n_latam.document.type',
				'search_read',
				[filters],
				{
					fields: ['id', 'code', 'name', 'internal_type', 'sequence'],
					limit: 1,
					order: 'sequence asc', // Igual que Odoo: _order = 'sequence, id'
				},
			]);
			this.logger.log(`📋 documentTypes ${countryCode}: ${JSON.stringify(documentTypes, null, 2)}`);

			if (!documentTypes || documentTypes.length === 0) {
				this.logger.log(`ℹ️ No se encontró tipo de documento para país ${countryId}, tipo ${internalType} (compañía ${companyId})`);
				this.defaultDocTypeCache.set(cacheKey, null);
				return null;
			}

			const docType: DefaultDocumentType = {
				id: documentTypes[0].id,
				code: documentTypes[0].code,
				name: documentTypes[0].name,
				internal_type: documentTypes[0].internal_type,
			};

			this.defaultDocTypeCache.set(cacheKey, docType);

			this.logger.log(
				`✅ Tipo de documento obtenido: ID=${docType.id}, Código="${docType.code}", Nombre="${docType.name}", ` +
					`Secuencia=${documentTypes[0].sequence} (país ${countryCode}, compañía ${companyId}, tipo ${moveType})`
			);

			return docType;
		} catch (error) {
			this.logger.error(`Error obteniendo tipo de documento por defecto: ${error.message}`, error.stack);
			this.defaultDocTypeCache.set(cacheKey, null);
			return null;
		}
	}

	clearCache(holdingId?: string): void {
		if (holdingId) {
			this.cache.delete(`${holdingId}`);
			this.logger.log(`Cache limpiado para holding ${holdingId}`);
		} else {
			this.cache.clear();
			this.defaultDocTypeCache.clear();
			this.logger.log('Cache completo limpiado');
		}
	}
}
