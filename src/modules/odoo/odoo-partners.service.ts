import { randomUUID } from 'crypto';

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';

import { ProcessPartnersDto, ProcessPartnersResponseDto } from './dtos/process-partners.dto';
import { SyncRetencionesResponseDto } from './dtos/sync-retenciones.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import { OdooConnectionConfig, OdooPartner } from './interfaces/odoo.interface';
import { OdooProvider } from './odoo.provider';
import { FieldMappingService } from './services/field-mapping.service';
import { GenericVatsService } from './services/generic-vats.service';
import { PartnersProcessorService } from './services/partners-processor.service';
import { areValuesEqual, normalizeValue } from './utils/value-comparison.util';

@Injectable()
export class OdooPartnersService {
	private readonly logger = new Logger(OdooPartnersService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		@Inject(forwardRef(() => PartnersProcessorService))
		private readonly partnersProcessorService: PartnersProcessorService,
		private readonly fieldMappingService: FieldMappingService,
		private readonly genericVatsService: GenericVatsService,
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
	 * Clasifica partners en staging según si necesitan crearse, actualizarse o ya están procesados
	 */
	async classifyPartners(
		holdingId: string,
		mappingId: string
	): Promise<{
		to_create: number;
		to_update: number;
		already_processed: number;
		total: number;
	}> {
		return await this.partnersProcessorService.classifyPartners(holdingId, mappingId);
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
	 * Método público para ser usado tanto en sincronización automática como en clasificación manual
	 */
	async determinePartnerProcessingStatus(
		partner: OdooPartner,
		holdingId: string
	): Promise<{ status: 'create' | 'update' | 'processed'; notes: string; changes?: Array<{ field: string; odoo_value: any; db_value: any }> }> {
		try {
			const partnerVat = partner.vat ? String(partner.vat) : null;
			const isGenericVat = await this.genericVatsService.isGenericExportVat(partnerVat);

			this.logger.log(`\n${'='.repeat(80)}`);
			this.logger.log(`🔍 CLASIFICANDO PARTNER: ${partner.name || partner.display_name} (ID: ${partner.id})`);
			this.logger.log(`   VAT: ${partnerVat || 'Sin VAT'}`);
			this.logger.log(`   Es VAT genérico: ${isGenericVat ? 'SÍ' : 'NO'}`);
			this.logger.log(`   Holding ID: ${holdingId}`);

			// 1. Si no hay VAT, buscar solo por odoo_partner_id
			if (!partnerVat || partnerVat === '') {
				this.logger.log(`   ➡️ Flujo: SIN VAT - Buscando por odoo_partner_id`);

				const existingByOdooId = await this.clientEntitiesRepository.findOne({
					where: {
						odoo_partner_id: partner.id,
						holding_id: holdingId,
					},
				});

				this.logger.log(`   🔎 Búsqueda por odoo_partner_id: ${existingByOdooId ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);

				if (existingByOdooId) {
					this.logger.log(`   ✅ RESULTADO: UPDATE - Cliente existente sin VAT`);
					this.logger.log(`${'='.repeat(80)}\n`);
					return {
						status: 'update',
						notes: 'Cliente existente sin VAT - marcado para actualización',
					};
				}

				this.logger.log(`   ✅ RESULTADO: CREATE - Partner sin VAT no existe`);
				this.logger.log(`${'='.repeat(80)}\n`);
				return {
					status: 'create',
					notes: 'Partner sin VAT - marcado para creación',
				};
			}

			// 2. Buscar por VAT + Odoo ID (identificador único para clientes integrados)
			this.logger.log(`   ➡️ Flujo: CON VAT - Búsqueda 1: Por VAT + odoo_partner_id`);
			const existingByVatAndOdooId = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
					odoo_partner_id: partner.id,
				},
			});

			this.logger.log(`   🔎 Búsqueda VAT+OdooID (${partnerVat} + ${partner.id}): ${existingByVatAndOdooId ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);

			if (existingByVatAndOdooId) {
				this.logger.log(`   🔄 Cliente encontrado, comparando cambios...`);
				const { hasChanges, changes } = await this.hasPartnerChanges(partner, existingByVatAndOdooId, holdingId);
				this.logger.log(`   📊 Cambios detectados: ${hasChanges ? 'SÍ' : 'NO'} (${changes.length} campos)`);

				if (hasChanges) {
					this.logger.log(`   ✅ RESULTADO: UPDATE - Cliente con cambios`);
					this.logger.log(`${'='.repeat(80)}\n`);
					return {
						status: 'update',
						notes: isGenericVat
							? `Cliente existente con VAT genérico (${partnerVat}) - marcado para actualización`
							: 'Cliente existente con cambios - marcado para actualización',
						changes,
					};
				}

				this.logger.log(`   ✅ RESULTADO: PROCESSED - Cliente sin cambios`);
				this.logger.log(`${'='.repeat(80)}\n`);
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
				this.logger.log(`   ⚠️ VAT GENÉRICO - Saltando búsqueda solo por VAT`);
				this.logger.log(`   ✅ RESULTADO: CREATE - Partner nuevo con VAT genérico`);
				this.logger.log(`${'='.repeat(80)}\n`);
				return {
					status: 'create',
					notes: `Partner nuevo con VAT genérico de exportación (${partnerVat}) - marcado para creación`,
				};
			}

			// 4. Buscar solo por VAT (puede ser un cliente creado manualmente en Sapira)
			// Solo para VATs NO genéricos
			this.logger.log(`   ➡️ Flujo: Búsqueda 2: Solo por VAT (cliente manual)`);
			const existingByVat = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
				},
			});

			this.logger.log(`   🔎 Búsqueda solo VAT (${partnerVat}): ${existingByVat ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);

			if (existingByVat) {
				this.logger.log(`   ✅ RESULTADO: UPDATE - Cliente manual encontrado por VAT`);
				this.logger.log(`${'='.repeat(80)}\n`);
				return {
					status: 'update',
					notes: 'Cliente existente en Sapira (sin odoo_partner_id) - marcado para actualización',
				};
			}

			// 5. No existe, marcar para creación
			this.logger.log(`   ✅ RESULTADO: CREATE - Partner nuevo (no existe en ninguna búsqueda)`);
			this.logger.log(`${'='.repeat(80)}\n`);
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
		statusFilter?: string[],
		searchTerm?: string
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

		// Aplicar búsqueda si existe
		if (searchTerm && searchTerm.trim()) {
			const trimmedSearch = searchTerm.trim();

			// Si el término de búsqueda es un número, buscar por odoo_id exacto
			const isNumeric = /^\d+$/.test(trimmedSearch);

			if (isNumeric) {
				queryBuilder.andWhere('partner.odoo_id = :odooId', { odooId: parseInt(trimmedSearch, 10) });
			} else {
				// Búsqueda parcial en nombre, display_name y email
				queryBuilder.andWhere(
					`(
						partner.raw_data->>'name' ILIKE :search OR
						partner.raw_data->>'display_name' ILIKE :search OR
						partner.raw_data->>'email' ILIKE :search OR
						partner.raw_data->>'email_normalized' ILIKE :search
					)`,
					{ search: `%${trimmedSearch}%` }
				);
			}
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

	/**
	 * Sincroniza posiciones fiscales y retenciones desde facturas recientes de Odoo
	 */
	async syncPartnerRetenciones(holdingId: string): Promise<SyncRetencionesResponseDto> {
		this.logger.log(`🔄 Iniciando sincronización de posiciones fiscales y retenciones para holding ${holdingId}`);

		try {
			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const clientsWithOdooId = await this.clientEntitiesRepository
				.createQueryBuilder('client')
				.select([
					'client.id',
					'client.holding_id',
					'client.odoo_partner_id',
					'client.odoo_fiscal_position_id',
					'client.odoo_fiscal_position_name',
					'client.odoo_reteica_tax_id',
					'client.odoo_reteica_tax_name',
					'client.odoo_reteica_tax_amount',
					'client.odoo_retefuente_tax_id',
					'client.odoo_retefuente_tax_name',
					'client.odoo_retefuente_tax_amount',
					'client.odoo_reteiva_tax_id',
					'client.odoo_reteiva_tax_name',
					'client.odoo_reteiva_tax_amount',
				])
				.where('client.holding_id = :holdingId', { holdingId })
				.andWhere('client.odoo_partner_id IS NOT NULL')
				.getMany();

			if (clientsWithOdooId.length === 0) {
				return {
					success: true,
					message: 'No hay client_entities con odoo_partner_id para sincronizar',
					total_partners: 0,
					updated_count: 0,
					skipped_count: 0,
					error_count: 0,
				};
			}

			this.logger.log(`📊 Encontrados ${clientsWithOdooId.length} client_entities con odoo_partner_id`);

			const partnerIds = [...new Set(clientsWithOdooId.map((c) => c.odoo_partner_id))];

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Obtener la factura más reciente de cada partner y sus tax IDs
			const partnerDataMap = new Map<
				number,
				{
					fiscal_position_id: number;
					fiscal_position_name: string;
					reteica_tax_id: number | null;
					reteica_tax_name: string | null;
					reteica_tax_amount: number | null;
					retefuente_tax_id: number | null;
					retefuente_tax_name: string | null;
					retefuente_tax_amount: number | null;
					reteiva_tax_id: number | null;
					reteiva_tax_name: string | null;
					reteiva_tax_amount: number | null;
				} | null
			>();

			for (const partnerId of partnerIds) {
				try {
					// Buscar la factura más reciente del partner
					const invoiceIds = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.move',
						'search',
						[
							[
								['partner_id', '=', partnerId],
								['move_type', '=', 'out_invoice'],
								['state', '=', 'posted'],
								['fiscal_position_id', '!=', false],
							],
						],
						{ limit: 1, order: 'date desc' },
					]);

					if (invoiceIds.length > 0) {
						const invoices = await objectClient.methodCall('execute_kw', [
							connection.database_name,
							uid,
							connection.api_key,
							'account.move',
							'read',
							[invoiceIds],
							{ fields: ['id', 'fiscal_position_id'] },
						]);

						if (invoices.length > 0 && invoices[0].fiscal_position_id) {
							const fiscalPositionData = invoices[0].fiscal_position_id;
							const fiscalPositionId = fiscalPositionData[0];
							const fiscalPositionName = fiscalPositionData[1];

							// Obtener los tax IDs de esta posición fiscal
							const fiscalPositions = await objectClient.methodCall('execute_kw', [
								connection.database_name,
								uid,
								connection.api_key,
								'account.fiscal.position',
								'read',
								[[fiscalPositionId]],
								{ fields: ['id', 'name', 'tax_ids'] },
							]);

							let reteicaTaxId: number | null = null;
							let reteicaTaxName: string | null = null;
							let reteicaTaxAmount: number | null = null;
							let retefuenteTaxId: number | null = null;
							let retefuenteTaxName: string | null = null;
							let retefuenteTaxAmount: number | null = null;
							let reteivaTaxId: number | null = null;
							let reteivaTaxName: string | null = null;
							let reteivaTaxAmount: number | null = null;

							if (fiscalPositions.length > 0 && fiscalPositions[0].tax_ids && fiscalPositions[0].tax_ids.length > 0) {
								const taxMappings = await objectClient.methodCall('execute_kw', [
									connection.database_name,
									uid,
									connection.api_key,
									'account.fiscal.position.tax',
									'read',
									[fiscalPositions[0].tax_ids],
									{ fields: ['id', 'tax_dest_id'] },
								]);

								const destTaxIds = taxMappings
									.map((mapping: any) =>
										mapping.tax_dest_id
											? Array.isArray(mapping.tax_dest_id)
												? mapping.tax_dest_id[0]
												: mapping.tax_dest_id
											: null
									)
									.filter((id: number | null) => id !== null);

								if (destTaxIds.length > 0) {
									const taxes = await objectClient.methodCall('execute_kw', [
										connection.database_name,
										uid,
										connection.api_key,
										'account.tax',
										'read',
										[destTaxIds],
										{ fields: ['id', 'name', 'amount', 'l10n_co_edi_type'] },
									]);

									taxes.forEach((tax: any) => {
										const taxName = tax.name.toLowerCase();
										const ediType = tax.l10n_co_edi_type
											? Array.isArray(tax.l10n_co_edi_type)
												? tax.l10n_co_edi_type[1]
												: tax.l10n_co_edi_type
											: '';

										if (ediType === 'ReteICA' || taxName.includes('reteica') || taxName.includes('rete ica')) {
											reteicaTaxId = tax.id;
											reteicaTaxName = tax.name || null;
											reteicaTaxAmount = tax.amount || null;
										} else if (
											ediType === 'ReteRenta' ||
											taxName.includes('retefuente') ||
											taxName.includes('rete fuente') ||
											taxName.includes('rtefte')
										) {
											retefuenteTaxId = tax.id;
											retefuenteTaxName = tax.name || null;
											retefuenteTaxAmount = tax.amount || null;
										} else if (ediType === 'ReteIVA' || taxName.includes('reteiva') || taxName.includes('rete iva')) {
											reteivaTaxId = tax.id;
											reteivaTaxName = tax.name || null;
											reteivaTaxAmount = tax.amount || null;
										}
									});
								}
							}

							partnerDataMap.set(partnerId, {
								fiscal_position_id: fiscalPositionId,
								fiscal_position_name: fiscalPositionName,
								reteica_tax_id: reteicaTaxId,
								reteica_tax_name: reteicaTaxName,
								reteica_tax_amount: reteicaTaxAmount,
								retefuente_tax_id: retefuenteTaxId,
								retefuente_tax_name: retefuenteTaxName,
								retefuente_tax_amount: retefuenteTaxAmount,
								reteiva_tax_id: reteivaTaxId,
								reteiva_tax_name: reteivaTaxName,
								reteiva_tax_amount: reteivaTaxAmount,
							});

							this.logger.log(
								`✅ Partner ${partnerId}: "${fiscalPositionName}" - ReteICA: ${reteicaTaxId} (${reteicaTaxAmount}%), RteFte: ${retefuenteTaxId} (${retefuenteTaxAmount}%), ReteIVA: ${reteivaTaxId} (${reteivaTaxAmount}%)`
							);
						} else {
							partnerDataMap.set(partnerId, null);
						}
					} else {
						partnerDataMap.set(partnerId, null);
					}
				} catch (error) {
					this.logger.error(`❌ Error consultando facturas del partner ${partnerId}: ${error.message}`);
					partnerDataMap.set(partnerId, null);
				}
			}

			// Actualizar client_entities
			let updatedCount = 0;
			let skippedCount = 0;
			let errorCount = 0;
			const errors: Array<{ partner_id: number; error: string }> = [];

			for (const client of clientsWithOdooId) {
				try {
					const partnerData = partnerDataMap.get(client.odoo_partner_id);

					if (!partnerData) {
						skippedCount++;
						continue;
					}

					const hasChanges =
						client.odoo_fiscal_position_id !== partnerData.fiscal_position_id ||
						client.odoo_fiscal_position_name !== partnerData.fiscal_position_name ||
						client.odoo_reteica_tax_id !== partnerData.reteica_tax_id ||
						client.odoo_reteica_tax_name !== partnerData.reteica_tax_name ||
						client.odoo_reteica_tax_amount !== partnerData.reteica_tax_amount ||
						client.odoo_retefuente_tax_id !== partnerData.retefuente_tax_id ||
						client.odoo_retefuente_tax_name !== partnerData.retefuente_tax_name ||
						client.odoo_retefuente_tax_amount !== partnerData.retefuente_tax_amount ||
						client.odoo_reteiva_tax_id !== partnerData.reteiva_tax_id ||
						client.odoo_reteiva_tax_name !== partnerData.reteiva_tax_name ||
						client.odoo_reteiva_tax_amount !== partnerData.reteiva_tax_amount;

					if (!hasChanges) {
						skippedCount++;
						continue;
					}

					await this.clientEntitiesRepository.update(
						{ id: client.id },
						{
							odoo_fiscal_position_id: partnerData.fiscal_position_id,
							odoo_fiscal_position_name: partnerData.fiscal_position_name,
							odoo_reteica_tax_id: partnerData.reteica_tax_id,
							odoo_reteica_tax_name: partnerData.reteica_tax_name,
							odoo_reteica_tax_amount: partnerData.reteica_tax_amount,
							odoo_retefuente_tax_id: partnerData.retefuente_tax_id,
							odoo_retefuente_tax_name: partnerData.retefuente_tax_name,
							odoo_retefuente_tax_amount: partnerData.retefuente_tax_amount,
							odoo_reteiva_tax_id: partnerData.reteiva_tax_id,
							odoo_reteiva_tax_name: partnerData.reteiva_tax_name,
							odoo_reteiva_tax_amount: partnerData.reteiva_tax_amount,
						}
					);

					updatedCount++;
					this.logger.log(
						`✅ Actualizado client ${client.id}: "${partnerData.fiscal_position_name}" - ReteICA: ${partnerData.reteica_tax_id} (${partnerData.reteica_tax_amount}%), RteFte: ${partnerData.retefuente_tax_id} (${partnerData.retefuente_tax_amount}%), ReteIVA: ${partnerData.reteiva_tax_id} (${partnerData.reteiva_tax_amount}%)`
					);
				} catch (error) {
					errorCount++;
					errors.push({
						partner_id: client.odoo_partner_id,
						error: error.message,
					});
					this.logger.error(`❌ Error actualizando client_entity ${client.id}: ${error.message}`);
				}
			}

			this.logger.log(`✅ Sincronización completada: ${updatedCount} actualizados, ${skippedCount} omitidos, ${errorCount} errores`);

			return {
				success: true,
				message: `Sincronización completada: ${updatedCount} actualizados, ${skippedCount} omitidos, ${errorCount} errores`,
				total_partners: clientsWithOdooId.length,
				updated_count: updatedCount,
				skipped_count: skippedCount,
				error_count: errorCount,
				errors: errors.length > 0 ? errors : undefined,
			};
		} catch (error) {
			this.logger.error(`❌ Error en syncPartnerRetenciones: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Obtiene las retenciones fiscales de un partner desde Odoo
	 * Busca la factura más reciente del partner y extrae su fiscal position y tax IDs
	 */
	async getPartnerRetentions(
		odooPartnerId: number,
		connection: OdooConnectionConfig
	): Promise<{
		fiscal_position_id: number | null;
		fiscal_position_name: string | null;
		reteica_tax_id: number | null;
		reteica_tax_name: string | null;
		reteica_tax_amount: number | null;
		retefuente_tax_id: number | null;
		retefuente_tax_name: string | null;
		retefuente_tax_amount: number | null;
		reteiva_tax_id: number | null;
		reteiva_tax_name: string | null;
		reteiva_tax_amount: number | null;
	} | null> {
		try {
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				this.logger.error('Falló la autenticación con Odoo');
				return null;
			}

			// Buscar la factura más reciente del partner con fiscal position
			const invoiceIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'search',
				[
					[
						['partner_id', '=', odooPartnerId],
						['move_type', '=', 'out_invoice'],
						['state', '=', 'posted'],
						['fiscal_position_id', '!=', false],
					],
				],
				{ limit: 1, order: 'invoice_date desc' },
			]);

			if (invoiceIds.length === 0) {
				this.logger.debug(`No se encontraron facturas con fiscal position para partner ${odooPartnerId}`);
				return null;
			}

			const invoices = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[invoiceIds],
				{ fields: ['id', 'fiscal_position_id'] },
			]);

			if (invoices.length === 0 || !invoices[0].fiscal_position_id) {
				return null;
			}

			const fiscalPositionData = invoices[0].fiscal_position_id;
			const fiscalPositionId = fiscalPositionData[0];
			const fiscalPositionName = fiscalPositionData[1];

			// Obtener los tax IDs de esta posición fiscal
			const fiscalPositions = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.fiscal.position',
				'read',
				[[fiscalPositionId]],
				{ fields: ['id', 'name', 'tax_ids'] },
			]);

			let reteicaTaxId: number | null = null;
			let reteicaTaxName: string | null = null;
			let reteicaTaxAmount: number | null = null;
			let retefuenteTaxId: number | null = null;
			let retefuenteTaxName: string | null = null;
			let retefuenteTaxAmount: number | null = null;
			let reteivaTaxId: number | null = null;
			let reteivaTaxName: string | null = null;
			let reteivaTaxAmount: number | null = null;

			if (fiscalPositions.length > 0 && fiscalPositions[0].tax_ids && fiscalPositions[0].tax_ids.length > 0) {
				const taxMappings = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.fiscal.position.tax',
					'read',
					[fiscalPositions[0].tax_ids],
					{ fields: ['id', 'tax_dest_id'] },
				]);

				const destTaxIds = taxMappings
					.map((mapping: any) =>
						mapping.tax_dest_id ? (Array.isArray(mapping.tax_dest_id) ? mapping.tax_dest_id[0] : mapping.tax_dest_id) : null
					)
					.filter((id: number | null) => id !== null);

				if (destTaxIds.length > 0) {
					const taxes = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.tax',
						'read',
						[destTaxIds],
						{ fields: ['id', 'name', 'amount', 'l10n_co_edi_type'] },
					]);

					taxes.forEach((tax: any) => {
						const taxName = tax.name.toLowerCase();
						const ediType = tax.l10n_co_edi_type
							? Array.isArray(tax.l10n_co_edi_type)
								? tax.l10n_co_edi_type[1]
								: tax.l10n_co_edi_type
							: '';

						if (ediType === 'ReteICA' || taxName.includes('reteica') || taxName.includes('rete ica')) {
							reteicaTaxId = tax.id;
							reteicaTaxName = tax.name || null;
							reteicaTaxAmount = tax.amount || null;
						} else if (
							ediType === 'ReteRenta' ||
							taxName.includes('retefuente') ||
							taxName.includes('rete fuente') ||
							taxName.includes('rtefte')
						) {
							retefuenteTaxId = tax.id;
							retefuenteTaxName = tax.name || null;
							retefuenteTaxAmount = tax.amount || null;
						} else if (ediType === 'ReteIVA' || taxName.includes('reteiva') || taxName.includes('rete iva')) {
							reteivaTaxId = tax.id;
							reteivaTaxName = tax.name || null;
							reteivaTaxAmount = tax.amount || null;
						}
					});
				}
			}

			return {
				fiscal_position_id: fiscalPositionId,
				fiscal_position_name: fiscalPositionName,
				reteica_tax_id: reteicaTaxId,
				reteica_tax_name: reteicaTaxName,
				reteica_tax_amount: reteicaTaxAmount,
				retefuente_tax_id: retefuenteTaxId,
				retefuente_tax_name: retefuenteTaxName,
				retefuente_tax_amount: retefuenteTaxAmount,
				reteiva_tax_id: reteivaTaxId,
				reteiva_tax_name: reteivaTaxName,
				reteiva_tax_amount: reteivaTaxAmount,
			};
		} catch (error) {
			this.logger.error(`Error obteniendo retenciones para partner ${odooPartnerId}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Obtiene la conexión activa de Odoo para un holding
	 */
	private async getOdooConnectionByHoldingId(holdingId: string): Promise<OdooConnectionConfig | null> {
		const connection = await this.odooConnectionRepository.findOne({
			where: {
				holding_id: holdingId,
				is_active: true,
			},
		});

		if (!connection) {
			return null;
		}

		return {
			id: connection.id,
			url: connection.url,
			database_name: connection.database_name,
			username: connection.username,
			api_key: connection.api_key,
			holding_id: connection.holding_id,
		};
	}
}
