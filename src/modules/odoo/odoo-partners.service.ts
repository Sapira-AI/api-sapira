import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';

import { isGenericExportVat } from './constants/generic-vats.constant';
import { ProcessPartnersDto, ProcessPartnersResponseDto } from './dtos/process-partners.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import { OdooConnectionConfig, OdooPartner } from './interfaces/odoo.interface';
import { OdooProvider } from './odoo.provider';
import { FieldMappingService } from './services/field-mapping.service';
import { PartnersProcessorService } from './services/partners-processor.service';
import { areValuesEqual, normalizeValue } from './utils/value-comparison.util';

@Injectable()
export class OdooPartnersService {
	private readonly logger = new Logger(OdooPartnersService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		private readonly partnersProcessorService: PartnersProcessorService,
		private readonly fieldMappingService: FieldMappingService,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		@InjectRepository(OdooPartnersStg)
		private readonly partnersStgRepository: Repository<OdooPartnersStg>,
		@InjectRepository(ClientEntity)
		private readonly clientEntitiesRepository: Repository<ClientEntity>,
		@InjectRepository(FieldMapping)
		private readonly fieldMappingRepository: Repository<FieldMapping>
	) {}

	/**
	 * Procesa partners desde staging hacia client_entities usando mapeo configurado
	 */
	async processPartners(dto: ProcessPartnersDto): Promise<ProcessPartnersResponseDto> {
		return await this.partnersProcessorService.processPartners(dto);
	}

	/**
	 * Sincroniza un partner específico de Odoo a partners_stg por su ID
	 */
	async syncPartnerById(
		holdingId: string,
		odooPartnerId: number
	): Promise<{
		success: boolean;
		message: string;
		partner_synced: boolean;
		partner_data?: OdooPartnersStg;
	}> {
		try {
			// Obtener conexión activa del holding
			const activeConnection = await this.odooConnectionRepository.findOne({
				where: {
					holding_id: holdingId,
					is_active: true,
				},
			});

			if (!activeConnection) {
				throw new Error(`No se encontró una conexión activa de Odoo para el holding ${holdingId}`);
			}

			// Convertir a formato OdooConnectionConfig
			const connection: OdooConnectionConfig = {
				id: activeConnection.id,
				url: activeConnection.url,
				database_name: activeConnection.database_name,
				username: activeConnection.username || '',
				api_key: activeConnection.api_key,
				holding_id: activeConnection.holding_id,
			};

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar con Odoo
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			// Obtener datos del partner desde Odoo
			const partners = await this.getPartnersData(objectClient, connection, uid, [odooPartnerId]);

			if (!Array.isArray(partners) || partners.length === 0) {
				return {
					success: false,
					message: `Partner con ID ${odooPartnerId} no encontrado en Odoo`,
					partner_synced: false,
				};
			}

			const partner = partners[0];

			// Generar batch ID para esta sincronización
			const batchId = randomUUID();

			// Guardar partner en partners_stg
			const savedPartner = await this.savePartnerToDatabase(partner, batchId, connection.holding_id);

			return {
				success: true,
				message: `Partner ${partner.name || partner.display_name} sincronizado exitosamente`,
				partner_synced: true,
				partner_data: savedPartner,
			};
		} catch (error) {
			console.error('❌ Error sincronizando partner:', error);
			throw new Error(`Error al sincronizar partner: ${error.message}`);
		}
	}

	/**
	 * Obtiene datos de partners desde Odoo
	 */
	private async getPartnersData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnectionConfig,
		uid: number,
		partnerIds: number[]
	): Promise<OdooPartner[]> {
		return await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'res.partner',
			'read',
			[partnerIds],
			{
				fields: [
					'id',
					'name',
					'display_name',
					'ref',
					'active',
					'email',
					'phone',
					'mobile',
					'website',
					'email_normalized',
					'phone_sanitized',
					'street',
					'street2',
					'city',
					'zip',
					'state_id',
					'country_id',
					'contact_address_complete',
					'vat',
					'commercial_partner_id',
					'is_company',
					'company_type',
					'category_id',
					'industry_id',
					'function',
					'title',
					'create_date',
					'write_date',
					'create_uid',
					'write_uid',
					'l10n_cl_activity_description',
				],
			},
		]);
	}

	/**
	 * Guarda un partner en la tabla de staging
	 */
	private async savePartnerToDatabase(partner: OdooPartner, batchId: string, holdingId: string): Promise<OdooPartnersStg> {
		// 1. Verificar si el partner ya existe en staging
		const existingPartnerStg = await this.partnersStgRepository.findOne({
			where: {
				odoo_id: partner.id,
				holding_id: holdingId,
			},
		});

		// 2. Determinar el processing_status verificando client_entities
		const processingStatus = await this.determinePartnerProcessingStatus(partner, holdingId);

		// 3. Preparar integration_notes: si hay cambios, guardarlos como JSON, sino usar el mensaje de texto
		const integrationNotes =
			processingStatus.changes && processingStatus.changes.length > 0
				? JSON.stringify({ changes: processingStatus.changes })
				: processingStatus.notes;

		if (existingPartnerStg) {
			existingPartnerStg.raw_data = partner;
			existingPartnerStg.sync_batch_id = batchId;
			existingPartnerStg.processing_status = processingStatus.status;
			existingPartnerStg.integration_notes = integrationNotes;
			existingPartnerStg.updated_at = new Date();
			return await this.partnersStgRepository.save(existingPartnerStg);
		}

		const partnerStg = new OdooPartnersStg();
		partnerStg.odoo_id = partner.id;
		partnerStg.holding_id = holdingId;
		partnerStg.raw_data = partner;
		partnerStg.sync_batch_id = batchId;
		partnerStg.processing_status = processingStatus.status;
		partnerStg.integration_notes = integrationNotes;
		return await this.partnersStgRepository.save(partnerStg);
	}

	/**
	 * Determina el processing_status de un partner verificando su existencia en client_entities
	 */
	private async determinePartnerProcessingStatus(
		partner: OdooPartner,
		holdingId: string
	): Promise<{ status: 'create' | 'update' | 'processed'; notes: string; changes?: Array<{ field: string; odoo_value: any; db_value: any }> }> {
		try {
			const partnerVat = partner.vat ? String(partner.vat) : null;
			const isGenericVat = isGenericExportVat(partnerVat);

			// 1. Si no hay VAT, buscar solo por odoo_partner_id
			if (!partnerVat || partnerVat === '') {
				const existingByOdooId = await this.clientEntitiesRepository.findOne({
					where: {
						odoo_partner_id: partner.id,
						holding_id: holdingId,
					},
				});

				if (existingByOdooId) {
					return {
						status: 'update',
						notes: 'Cliente existente sin VAT - marcado para actualización',
					};
				}

				return {
					status: 'create',
					notes: 'Partner sin VAT - marcado para creación',
				};
			}

			// 2. Buscar por VAT + Odoo ID (identificador único para clientes integrados)
			const existingByVatAndOdooId = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
					odoo_partner_id: partner.id,
				},
			});

			if (existingByVatAndOdooId) {
				const { hasChanges, changes } = await this.hasPartnerChanges(partner, existingByVatAndOdooId, holdingId);
				if (hasChanges) {
					return {
						status: 'update',
						notes: isGenericVat
							? `Cliente existente con VAT genérico (${partnerVat}) - marcado para actualización`
							: 'Cliente existente con cambios - marcado para actualización',
						changes, // Retornar los cambios para que se guarden en savePartnerToDatabase
					};
				}

				return {
					status: 'processed',
					notes: isGenericVat
						? `Cliente existente con VAT genérico (${partnerVat}) sin cambios - ya procesado`
						: 'Cliente existente sin cambios - ya procesado',
				};
			}

			// 3. IMPORTANTE: Si es VAT genérico, NO buscar solo por VAT
			// Los VATs genéricos pueden estar asociados a múltiples clientes
			if (isGenericVat) {
				this.logger.log(`⚠️ VAT genérico detectado: ${partnerVat}. No se buscará solo por VAT. Partner marcado para creación.`);
				return {
					status: 'create',
					notes: `Partner nuevo con VAT genérico de exportación (${partnerVat}) - marcado para creación`,
				};
			}

			// 4. Buscar solo por VAT (puede ser un cliente creado manualmente en Sapira)
			// Solo para VATs NO genéricos
			const existingByVat = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
				},
			});

			if (existingByVat) {
				return {
					status: 'update',
					notes: 'Cliente existente en Sapira (sin odoo_partner_id) - marcado para actualización',
				};
			}

			// 5. No existe, marcar para creación
			return {
				status: 'create',
				notes: 'Partner nuevo - marcado para creación',
			};
		} catch (error) {
			console.error('Error determinando processing_status:', error);
			return {
				status: 'create',
				notes: `Error al determinar status: ${error.message}`,
			};
		}
	}

	/**
	 * Verifica si hay cambios entre el partner de Odoo y el cliente en Sapira usando mapeo dinámico
	 */
	async hasPartnerChanges(
		partner: OdooPartner,
		clientEntity: ClientEntity,
		holdingId: string
	): Promise<{ hasChanges: boolean; changes: Array<{ field: string; odoo_value: any; db_value: any }> }> {
		try {
			// Obtener la configuración de mapeo para partners
			const mappingConfig = await this.fieldMappingService.getMappingConfig(holdingId, 'res.partner', 'client_entities');

			// Si no hay mapeo configurado, usar comparación básica
			if (!mappingConfig) {
				this.logger.warn(`⚠️ No hay mapeo configurado para partners, usando comparación básica`);
				return this.hasPartnerChangesBasic(partner, clientEntity);
			}

			// El mapeo de partners se guarda como un objeto plano, no como partner_mappings
			// Aplicar mapeo a los datos del partner para obtener los valores transformados
			const mappedData = await this.fieldMappingService.applyFieldMappingToData(
				partner as Record<string, any>,
				mappingConfig as any, // El mapeo completo
				'client_entities',
				holdingId
			);

			// Comparar cada campo mapeado y capturar cambios
			const changes: Array<{ field: string; odoo_value: any; db_value: any }> = [];

			for (const [fieldKey, mappedValue] of Object.entries(mappedData)) {
				// Saltar campos que no se deben comparar
				if (
					fieldKey === 'id' ||
					fieldKey === 'created_at' ||
					fieldKey === 'updated_at' ||
					fieldKey === 'holding_id' ||
					fieldKey === 'odoo_partner_id' ||
					fieldKey === 'client_id'
				) {
					continue;
				}

				const clientValue = clientEntity[fieldKey];

				// Comparar valores normalizados
				if (!areValuesEqual(mappedValue, clientValue)) {
					this.logger.debug(`🔄 Campo '${fieldKey}' cambió: client='${clientValue}' → partner='${mappedValue}'`);
					changes.push({
						field: fieldKey,
						odoo_value: mappedValue,
						db_value: clientValue,
					});
				}
			}

			if (changes.length === 0) {
				this.logger.debug(`✅ Sin cambios detectados en campos mapeados`);
			}

			return { hasChanges: changes.length > 0, changes };
		} catch (error) {
			this.logger.error(`❌ Error comparando campos de partner:`, error);
			// En caso de error, usar comparación básica como fallback
			return this.hasPartnerChangesBasic(partner, clientEntity);
		}
	}

	/**
	 * Comparación básica de partners (fallback cuando no hay mapeo configurado)
	 */
	private hasPartnerChangesBasic(
		partner: OdooPartner,
		clientEntity: ClientEntity
	): { hasChanges: boolean; changes: Array<{ field: string; odoo_value: any; db_value: any }> } {
		const changes: Array<{ field: string; odoo_value: any; db_value: any }> = [];

		// Comparar nombre
		const partnerName = partner.name || partner.display_name;
		const clientName = clientEntity.legal_name;
		if (normalizeValue(partnerName) !== normalizeValue(clientName)) {
			changes.push({
				field: 'legal_name',
				odoo_value: partnerName,
				db_value: clientName,
			});
		}

		// Comparar email
		const partnerEmail = partner.email;
		const clientEmail = clientEntity.email;
		if (normalizeValue(partnerEmail) !== normalizeValue(clientEmail)) {
			changes.push({
				field: 'email',
				odoo_value: partnerEmail,
				db_value: clientEmail,
			});
		}

		// Comparar teléfono
		const partnerPhone = partner.phone || partner.mobile;
		const clientPhone = clientEntity.phone;
		if (normalizeValue(partnerPhone) !== normalizeValue(clientPhone)) {
			changes.push({
				field: 'phone',
				odoo_value: partnerPhone,
				db_value: clientPhone,
			});
		}

		return { hasChanges: changes.length > 0, changes };
	}

	/**
	 * Obtiene la configuración de conexión de Odoo
	 */
	private async getOdooConnection(connectionId: string): Promise<OdooConnectionConfig> {
		try {
			let dbConnection: OdooConnection | null = null;

			if (this.isValidUUID(connectionId)) {
				dbConnection = await this.odooConnectionRepository.findOne({
					where: { id: connectionId, is_active: true },
				});
			} else {
				dbConnection = await this.odooConnectionRepository.findOne({
					where: { name: connectionId, is_active: true },
				});
			}

			if (dbConnection) {
				return {
					id: dbConnection.id,
					url: dbConnection.url,
					database_name: dbConnection.database_name,
					username: dbConnection.username || '',
					api_key: dbConnection.api_key,
					holding_id: dbConnection.holding_id,
				};
			}

			throw new Error(`Conexión Odoo no encontrada o inactiva para connectionId: ${connectionId}`);
		} catch (error) {
			console.error('Error obteniendo conexión Odoo desde BD:', error);
			throw new Error(`No se pudo obtener la conexión Odoo para connectionId: ${connectionId}. ${error.message}`);
		}
	}

	/**
	 * Valida si un string es un UUID válido
	 */
	private isValidUUID(uuid: string): boolean {
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		return uuidRegex.test(uuid);
	}

	/**
	 * Obtiene los conteos de partners por estado de procesamiento
	 */
	async getStatusCounts(holdingId: string): Promise<{
		create: number;
		update: number;
		processed: number;
		error: number;
		null: number;
	}> {
		const partners = await this.partnersStgRepository.find({
			where: { holding_id: holdingId },
			select: ['processing_status'],
		});

		const counts = {
			create: 0,
			update: 0,
			processed: 0,
			error: 0,
			null: 0,
		};

		partners.forEach((partner) => {
			const status = partner.processing_status || 'null';
			if (status in counts) {
				counts[status]++;
			} else {
				counts.null++;
			}
		});

		return counts;
	}

	/**
	 * Obtiene partners staging con paginación y filtros
	 */
	async getStagingPartners(
		holdingId: string,
		page: number = 1,
		limit: number = 20,
		statusFilter?: string[]
	): Promise<{
		partners: OdooPartnersStg[];
		total: number;
		page: number;
		totalPages: number;
	}> {
		const queryBuilder = this.partnersStgRepository
			.createQueryBuilder('partner')
			.where('partner.holding_id = :holdingId', { holdingId })
			.orderBy('partner.created_at', 'DESC');

		// Aplicar filtro de estado si existe
		if (statusFilter && statusFilter.length > 0) {
			queryBuilder.andWhere('partner.processing_status IN (:...statuses)', { statuses: statusFilter });
		}

		// Obtener total
		const total = await queryBuilder.getCount();

		// Aplicar paginación
		const offset = (page - 1) * limit;
		queryBuilder.skip(offset).take(limit);

		// Obtener datos
		const partners = await queryBuilder.getMany();

		return {
			partners,
			total,
			page,
			totalPages: Math.ceil(total / limit),
		};
	}

	/**
	 * Limpia (elimina) partners procesados
	 */
	async cleanProcessedPartners(holdingId: string): Promise<{
		deleted_count: number;
		message: string;
	}> {
		const result = await this.partnersStgRepository.delete({
			holding_id: holdingId,
			processing_status: 'processed',
		});

		const deletedCount = result.affected || 0;

		return {
			deleted_count: deletedCount,
			message: `Se eliminaron ${deletedCount} registros procesados`,
		};
	}
}
