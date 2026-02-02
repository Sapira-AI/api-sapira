import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';

import { ProcessPartnersDto, ProcessPartnersResponseDto } from '../dtos/process-partners.dto';
import { OdooPartnersStg } from '../entities/odoo-partners-stg.entity';

@Injectable()
export class PartnersProcessorService {
	private readonly logger = new Logger(PartnersProcessorService.name);

	constructor(
		@InjectRepository(OdooPartnersStg)
		private readonly partnersStgRepository: Repository<OdooPartnersStg>,
		@InjectRepository(ClientEntity)
		private readonly clientEntitiesRepository: Repository<ClientEntity>,
		@InjectRepository(FieldMapping)
		private readonly fieldMappingsRepository: Repository<FieldMapping>
	) {}

	async processPartners(dto: ProcessPartnersDto): Promise<ProcessPartnersResponseDto> {
		this.logger.log('='.repeat(80));
		this.logger.log('🚀 INICIO DE PROCESAMIENTO DE PARTNERS');
		this.logger.log(`📋 Holding ID: ${dto.holding_id}`);
		this.logger.log(`🗺️  Mapping ID: ${dto.mapping_id}`);
		this.logger.log(`🎯 Partner IDs específicos: ${dto.partner_ids?.length ? dto.partner_ids.join(', ') : 'Todos'}`);
		this.logger.log('='.repeat(80));

		try {
			// Obtener el mapeo configurado
			this.logger.log('🔍 Buscando configuración de mapeo...');
			const mapping = await this.fieldMappingsRepository.findOne({
				where: {
					id: dto.mapping_id,
					holding_id: dto.holding_id,
				},
			});

			if (!mapping) {
				this.logger.error(`❌ Mapeo ${dto.mapping_id} no encontrado para holding ${dto.holding_id}`);
				throw new NotFoundException(`Mapeo ${dto.mapping_id} no encontrado`);
			}

			this.logger.log(`✅ Mapeo encontrado: ${mapping.mapping_name || 'Sin nombre'}`);
			this.logger.log(`📊 Configuración de mapeo:`);
			this.logger.log(JSON.stringify(mapping.mapping_config, null, 2));

			const mappingConfig = mapping.mapping_config;
			const mappings = mappingConfig?.mappings || {};
			this.logger.log(`🔧 Total de campos a mapear: ${Object.keys(mappings).length}`);

			// Obtener partners a procesar
			const queryBuilder = this.partnersStgRepository
				.createQueryBuilder('partner')
				.where('partner.holding_id = :holdingId', { holdingId: dto.holding_id })
				.andWhere('partner.processing_status IN (:...statuses)', { statuses: ['create', 'update', 'processed'] })
				.orderBy('partner.created_at', 'DESC');

			// Si se especificaron IDs específicos, filtrar por ellos
			if (dto.partner_ids && dto.partner_ids.length > 0) {
				queryBuilder.andWhere('partner.id IN (:...ids)', { ids: dto.partner_ids });
			}

			const partners = await queryBuilder.getMany();
			this.logger.log(`📦 Partners encontrados: ${partners.length}`);

			if (!partners || partners.length === 0) {
				this.logger.warn('⚠️  No hay partners para procesar');
				return {
					success: true,
					message: 'No hay partners para procesar',
					results: {
						total: 0,
						success: 0,
						errors: 0,
						details: [],
					},
				};
			}

			// Procesar cada partner
			const results = [];
			let successCount = 0;
			let errorCount = 0;

			this.logger.log('\n' + '='.repeat(80));
			this.logger.log('🔄 INICIANDO PROCESAMIENTO DE PARTNERS');
			this.logger.log('='.repeat(80) + '\n');

			for (const partner of partners) {
				this.logger.log('\n' + '-'.repeat(80));
				this.logger.log(`🔍 Procesando Partner #${partner.id} | Odoo ID: ${partner.odoo_id}`);
				this.logger.log(`📊 Estado: ${partner.processing_status}`);
				this.logger.log(`📅 Creado: ${partner.created_at}`);
				this.logger.log('-'.repeat(80));
				try {
					this.logger.log('🔧 Construyendo objeto mapeado...');
					// Construir el objeto mapeado
					const mappedData: Record<string, any> = {
						odoo_partner_id: partner.odoo_id,
						holding_id: dto.holding_id,
					};
					this.logger.log(`📝 Datos base: odoo_partner_id=${partner.odoo_id}, holding_id=${dto.holding_id}`);

					// Aplicar cada mapeo configurado
					Object.entries(mappings).forEach(([targetField, mappingInfo]: [string, any]) => {
						const sourceFieldName = mappingInfo.sourceField?.name;
						const transformation = mappingInfo.transformation || sourceFieldName;

						if (sourceFieldName && transformation) {
							let mappedValue = null;

							try {
								// Manejar transformaciones de arrays (ej: country_id[1])
								if (transformation.includes('[') && transformation.includes(']')) {
									const match = transformation.match(/^(.+)\[(\d+)\]$/);
									if (match) {
										const fieldName = match[1];
										const index = parseInt(match[2]);
										const fieldValue = partner.raw_data[fieldName];

										if (Array.isArray(fieldValue) && fieldValue.length > index) {
											mappedValue = fieldValue[index];
										}
									}
								} else {
									// Transformación directa
									if (partner.raw_data[transformation] !== undefined) {
										mappedValue = partner.raw_data[transformation];
									}
								}

								// Asignar valor si se obtuvo algo válido
								if (mappedValue !== null && mappedValue !== undefined) {
									mappedData[targetField] = mappedValue;
									this.logger.debug(`  ✓ ${targetField} = ${JSON.stringify(mappedValue).substring(0, 100)}`);
								} else {
									this.logger.debug(`  ⚠️  ${targetField}: valor nulo/indefinido`);
								}
							} catch (transformError) {
								this.logger.error(`❌ Error aplicando transformación ${transformation}:`, transformError);
							}
						}
					});

					// Asegurar que odoo_partner_id siempre se incluya
					const dataWithOdooId = {
						...mappedData,
						odoo_partner_id: partner.odoo_id,
					};

					this.logger.log('\n📦 Datos mapeados finales:');
					this.logger.log(JSON.stringify(dataWithOdooId, null, 2));

					// Usar el processing_status para decidir la acción
					if (partner.processing_status === 'create') {
						this.logger.log('\n🆕 OPERACIÓN: CREATE');
						this.logger.log('💾 Insertando nuevo cliente en la base de datos...');

						try {
							const savedEntity = await this.clientEntitiesRepository.save(dataWithOdooId);
							this.logger.log('✅ ÉXITO: Cliente creado correctamente');
							this.logger.log(`🆔 ID generado: ${savedEntity.id}`);
							this.logger.log('📊 Respuesta de BD:');
							this.logger.log(JSON.stringify(savedEntity, null, 2));

							// Actualizar estado en staging a 'processed'
							await this.partnersStgRepository.update(partner.id, {
								processing_status: 'processed',
								last_integrated_at: new Date(),
								integration_notes: `Cliente creado exitosamente - ID: ${savedEntity.id}`,
							});
							this.logger.log('✅ Estado actualizado en staging: processed');

							successCount++;
							results.push({
								odoo_id: partner.odoo_id,
								status: 'success',
								action: 'create',
								staging_id: partner.id,
								client_id: savedEntity.id,
							});
						} catch (dbError) {
							this.logger.error('❌ ERROR EN BD AL CREAR:');
							this.logger.error(`Mensaje: ${dbError.message}`);
							this.logger.error(`Código: ${dbError.code}`);
							this.logger.error(`Detalle: ${dbError.detail || 'N/A'}`);
							this.logger.error('Stack trace:', dbError.stack);

							// Guardar error en staging
							const errorMessage = `${dbError.name}: ${dbError.message}`;
							await this.partnersStgRepository.update(partner.id, {
								processing_status: 'error',
								error_message: errorMessage,
								last_integrated_at: new Date(),
								integration_notes: `Error al crear cliente: ${dbError.message}`,
							});

							throw dbError;
						}
					} else if (partner.processing_status === 'update') {
						this.logger.log('\n🔄 OPERACIÓN: UPDATE');
						const partnerVat = String(partner.raw_data?.vat || '');
						this.logger.log(`🔍 Buscando cliente existente con VAT: ${partnerVat || 'N/A'} y Odoo ID: ${partner.odoo_id}`);

						let existingClient = null;

						if (partnerVat) {
							// Buscar primero por VAT + Odoo ID (identificador único para clientes integrados)
							existingClient = await this.clientEntitiesRepository.findOne({
								where: {
									tax_id: partnerVat,
									holding_id: dto.holding_id,
									odoo_partner_id: partner.odoo_id,
								},
							});

							// Si no se encuentra, buscar por VAT solamente (para clientes creados manualmente)
							if (!existingClient) {
								this.logger.log('🔍 No encontrado con Odoo ID, buscando solo por VAT (cliente manual)...');
								existingClient = await this.clientEntitiesRepository.findOne({
									where: {
										tax_id: partnerVat,
										holding_id: dto.holding_id,
									},
								});

								if (existingClient) {
									this.logger.log(
										`✅ Cliente manual encontrado: ID=${existingClient.id}, se vinculará con Odoo ID ${partner.odoo_id}`
									);
								}
							}
						}

						// Si no hay VAT o no se encontró por VAT, buscar solo por odoo_partner_id + holding_id
						if (!existingClient) {
							this.logger.log('🔍 Buscando por Odoo ID + Holding ID...');
							existingClient = await this.clientEntitiesRepository.findOne({
								where: {
									odoo_partner_id: partner.odoo_id,
									holding_id: dto.holding_id,
								},
							});

							if (existingClient) {
								this.logger.log(`✅ Cliente encontrado por Odoo ID: ID=${existingClient.id}`);
							}
						}

						if (!existingClient) {
							this.logger.error('❌ ERROR: Cliente no encontrado en BD');
							this.logger.error(`VAT buscado: ${partnerVat}, Odoo ID: ${partner.odoo_id}, Holding: ${dto.holding_id}`);
							errorCount++;
							results.push({
								odoo_id: partner.odoo_id,
								status: 'error',
								error: 'Cliente marcado para update pero no encontrado',
								staging_id: partner.id,
							});
							continue;
						}

						this.logger.log(`✅ Cliente encontrado: ID=${existingClient.id}`);
						this.logger.log('💾 Actualizando cliente en la base de datos...');

						try {
							const updateResult = await this.clientEntitiesRepository.update(existingClient.id, dataWithOdooId);
							this.logger.log('✅ ÉXITO: Cliente actualizado correctamente');
							this.logger.log(`📊 Respuesta de BD - Filas afectadas: ${updateResult.affected}`);
							this.logger.log(JSON.stringify(updateResult, null, 2));

							// Obtener el registro actualizado para mostrarlo
							const updatedClient = await this.clientEntitiesRepository.findOne({ where: { id: existingClient.id } });
							this.logger.log('📋 Datos actualizados:');
							this.logger.log(JSON.stringify(updatedClient, null, 2));

							// Actualizar estado en staging a 'processed'
							await this.partnersStgRepository.update(partner.id, {
								processing_status: 'processed',
								last_integrated_at: new Date(),
								integration_notes: `Cliente actualizado exitosamente - ID: ${existingClient.id}`,
							});
							this.logger.log('✅ Estado actualizado en staging: processed');

							successCount++;
							results.push({
								odoo_id: partner.odoo_id,
								status: 'success',
								action: 'update',
								staging_id: partner.id,
								client_id: existingClient.id,
							});
						} catch (dbError) {
							this.logger.error('❌ ERROR EN BD AL ACTUALIZAR:');
							this.logger.error(`Mensaje: ${dbError.message}`);
							this.logger.error(`Código: ${dbError.code}`);
							this.logger.error(`Detalle: ${dbError.detail || 'N/A'}`);
							this.logger.error('Stack trace:', dbError.stack);

							// Guardar error en staging
							const errorMessage = `${dbError.name}: ${dbError.message}`;
							await this.partnersStgRepository.update(partner.id, {
								processing_status: 'error',
								error_message: errorMessage,
								last_integrated_at: new Date(),
								integration_notes: `Error al actualizar cliente: ${dbError.message}`,
							});

							throw dbError;
						}
					} else {
						// Estado no válido para procesamiento
						this.logger.warn(`⚠️  Partner ${partner.odoo_id} tiene estado no procesable: ${partner.processing_status}`);
						continue;
					}
				} catch (partnerError) {
					this.logger.error('\n' + '❌'.repeat(40));
					this.logger.error(`❌ ERROR PROCESANDO PARTNER ${partner.odoo_id}`);
					this.logger.error('❌'.repeat(40));
					this.logger.error(`Mensaje: ${partnerError.message}`);
					this.logger.error(`Tipo: ${partnerError.name}`);
					this.logger.error('Stack completo:');
					this.logger.error(partnerError.stack);
					this.logger.error('Datos del partner:');
					this.logger.error(JSON.stringify(partner, null, 2));

					// Guardar error en staging
					const errorMessage = `${partnerError.name}: ${partnerError.message}`;
					try {
						await this.partnersStgRepository.update(partner.id, {
							processing_status: 'error',
							error_message: errorMessage,
							last_integrated_at: new Date(),
							integration_notes: `Error en procesamiento: ${partnerError.message}`,
						});
					} catch (updateError) {
						this.logger.error('❌ Error al actualizar staging con mensaje de error:', updateError);
					}

					errorCount++;
					results.push({
						odoo_id: partner.odoo_id,
						status: 'error',
						error: errorMessage,
						staging_id: partner.id,
					});
				}
			}

			this.logger.log('\n' + '='.repeat(80));
			this.logger.log('✅ PROCESAMIENTO COMPLETADO');
			this.logger.log('='.repeat(80));
			this.logger.log(`📊 Total procesados: ${partners.length}`);
			this.logger.log(`✅ Exitosos: ${successCount}`);
			this.logger.log(`❌ Errores: ${errorCount}`);
			this.logger.log(`📈 Tasa de éxito: ${((successCount / partners.length) * 100).toFixed(2)}%`);
			this.logger.log('='.repeat(80) + '\n');

			return {
				success: true,
				message: `Procesamiento completado: ${successCount} exitosos, ${errorCount} errores`,
				results: {
					total: partners.length,
					success: successCount,
					errors: errorCount,
					details: results,
				},
			};
		} catch (error) {
			this.logger.error('\n' + '💥'.repeat(40));
			this.logger.error('💥 ERROR CRÍTICO EN PROCESAMIENTO DE PARTNERS');
			this.logger.error('💥'.repeat(40));
			this.logger.error(`Mensaje: ${error.message}`);
			this.logger.error(`Tipo: ${error.name}`);
			this.logger.error('Stack completo:');
			this.logger.error(error.stack);
			this.logger.error('💥'.repeat(40) + '\n');
			throw error;
		}
	}
}
