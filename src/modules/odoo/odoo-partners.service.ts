import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';

import { ProcessPartnersDto, ProcessPartnersResponseDto } from './dtos/process-partners.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import { OdooConnectionConfig, OdooPartner } from './interfaces/odoo.interface';
import { OdooProvider } from './odoo.provider';
import { PartnersProcessorService } from './services/partners-processor.service';

@Injectable()
export class OdooPartnersService {
	private readonly logger = new Logger(OdooPartnersService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		private readonly partnersProcessorService: PartnersProcessorService,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		@InjectRepository(OdooPartnersStg)
		private readonly partnersStgRepository: Repository<OdooPartnersStg>,
		@InjectRepository(ClientEntity)
		private readonly clientEntitiesRepository: Repository<ClientEntity>,
		@InjectRepository(FieldMapping)
		private readonly fieldMappingsRepository: Repository<FieldMapping>
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
			console.log('🔄 Iniciando sincronización de partner individual');
			console.log(`📋 Holding ID: ${holdingId}`);
			console.log(`🆔 Odoo Partner ID: ${odooPartnerId}`);

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

			console.log(`✅ Conexión activa encontrada: ${activeConnection.name || activeConnection.database_name}`);

			// Convertir a formato OdooConnectionConfig
			const connection: OdooConnectionConfig = {
				id: activeConnection.id,
				url: activeConnection.url,
				database_name: activeConnection.database_name,
				username: activeConnection.username || '',
				api_key: activeConnection.api_key,
				holding_id: activeConnection.holding_id,
			};
			console.log(`✅ Conexión configurada: ${connection.database_name}`);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar con Odoo
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);
			console.log(`✅ Autenticación exitosa. UID: ${uid}`);

			// Obtener datos del partner desde Odoo
			console.log(`🔍 Obteniendo datos del partner ${odooPartnerId} desde Odoo...`);
			const partners = await this.getPartnersData(objectClient, connection, uid, [odooPartnerId]);

			if (!Array.isArray(partners) || partners.length === 0) {
				console.log(`⚠️ Partner ${odooPartnerId} no encontrado en Odoo`);
				return {
					success: false,
					message: `Partner con ID ${odooPartnerId} no encontrado en Odoo`,
					partner_synced: false,
				};
			}

			const partner = partners[0];
			console.log(`✅ Partner encontrado: ${partner.name || partner.display_name}`);

			// Generar batch ID para esta sincronización
			const batchId = randomUUID();

			// Guardar partner en partners_stg
			console.log(`💾 Guardando partner en partners_stg...`);
			const savedPartner = await this.savePartnerToDatabase(partner, batchId, connection.holding_id);

			console.log(`✅ Partner sincronizado exitosamente`);
			console.log(`📊 Processing status: ${savedPartner.processing_status}`);
			console.log(`📝 Notes: ${savedPartner.integration_notes}`);

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

		if (existingPartnerStg) {
			existingPartnerStg.raw_data = partner;
			existingPartnerStg.sync_batch_id = batchId;
			existingPartnerStg.processing_status = processingStatus.status;
			existingPartnerStg.integration_notes = processingStatus.notes;
			existingPartnerStg.updated_at = new Date();
			return await this.partnersStgRepository.save(existingPartnerStg);
		}

		const partnerStg = new OdooPartnersStg();
		partnerStg.odoo_id = partner.id;
		partnerStg.holding_id = holdingId;
		partnerStg.raw_data = partner;
		partnerStg.sync_batch_id = batchId;
		partnerStg.processing_status = processingStatus.status;
		partnerStg.integration_notes = processingStatus.notes;
		return await this.partnersStgRepository.save(partnerStg);
	}

	/**
	 * Determina el processing_status de un partner verificando su existencia en client_entities
	 */
	private async determinePartnerProcessingStatus(
		partner: OdooPartner,
		holdingId: string
	): Promise<{ status: 'create' | 'update' | 'processed'; notes: string }> {
		try {
			const partnerVat = partner.vat ? String(partner.vat) : null;

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
				const hasChanges = this.hasPartnerChanges(partner, existingByVatAndOdooId);
				if (hasChanges) {
					return {
						status: 'update',
						notes: 'Cliente existente con cambios - marcado para actualización',
					};
				}

				return {
					status: 'processed',
					notes: 'Cliente existente sin cambios - ya procesado',
				};
			}

			// 3. Buscar solo por VAT (puede ser un cliente creado manualmente en Sapira)
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

			// 4. No existe, marcar para creación
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
	 * Verifica si hay cambios entre el partner de Odoo y el cliente en Sapira
	 */
	private hasPartnerChanges(partner: OdooPartner, clientEntity: ClientEntity): boolean {
		const partnerName = partner.name || partner.display_name || '';
		const clientName = clientEntity.legal_name || '';

		const partnerEmail = partner.email || '';
		const clientEmail = clientEntity.email || '';

		const partnerPhone = partner.phone || partner.mobile || '';
		const clientPhone = clientEntity.phone || '';

		return partnerName !== clientName || partnerEmail !== clientEmail || partnerPhone !== clientPhone;
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
