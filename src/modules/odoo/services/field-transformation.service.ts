import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { Company } from '../entities/companies.entity';

export enum TransformationType {
	DIRECT = 'direct',
	COMPANY_MAPPING = 'company_mapping',
	PARTNER_MAPPING = 'partner_mapping',
	INVOICE_MAPPING = 'invoice_mapping',
	VALUE_MAPPING = 'value_mapping',
	LOOKUP_TABLE = 'lookup_table',
	CUSTOM_FUNCTION = 'custom_function',
}

export interface TransformationConfig {
	mappings?: Record<string, string>;
	default_value?: string;
	table?: string;
	source_column?: string;
	target_column?: string;
	filter_column?: string;
	filter_value?: string;
}

/**
 * Servicio para aplicar transformaciones a campos durante la integración
 * Replica la funcionalidad de resolve_field_transformation de PostgreSQL
 */
@Injectable()
export class FieldTransformationService {
	constructor(
		@InjectRepository(Company)
		private readonly companyRepository: Repository<Company>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>
	) {}

	/**
	 * Aplica una transformación a un valor según el tipo especificado
	 */
	async resolveFieldTransformation(
		transformationType: TransformationType,
		transformationConfig: TransformationConfig | null,
		sourceValue: string,
		holdingId: string
	): Promise<string> {
		try {
			// Transformación directa (sin cambios)
			if (transformationType === TransformationType.DIRECT) {
				return sourceValue;
			}

			// Mapeo de companies Odoo -> Sapira
			if (transformationType === TransformationType.COMPANY_MAPPING) {
				const company = await this.companyRepository.findOne({
					where: {
						odoo_integration_id: parseInt(sourceValue, 10),
						holding_id: holdingId,
					},
				});

				if (!company) {
					throw new Error(
						`No se encontró la compañía con odoo_integration_id=${sourceValue} en la tabla companies. ` +
							`Debes sincronizar las compañías desde Odoo primero.`
					);
				}

				return company.id;
			}

			// Mapeo de partners Odoo -> client_entities Sapira
			if (transformationType === TransformationType.PARTNER_MAPPING) {
				const clientEntity = await this.clientEntityRepository.findOne({
					where: {
						odoo_partner_id: parseInt(sourceValue, 10),
						holding_id: holdingId,
					},
				});

				if (!clientEntity) {
					throw new Error(
						`No se encontró el cliente con odoo_partner_id=${sourceValue} en la tabla client_entities. ` +
							`Debes sincronizar los partners/clientes desde Odoo primero.`
					);
				}

				return clientEntity.id;
			}

			// Mapeo de invoices Odoo -> invoices_legacy Sapira
			if (transformationType === TransformationType.INVOICE_MAPPING) {
				try {
					const result = await this.companyRepository.query(
						`SELECT id FROM invoices_legacy WHERE odoo_integration_id = $1 AND holding_id = $2 LIMIT 1`,
						[parseInt(sourceValue, 10), holdingId]
					);

					if (result && result.length > 0) {
						return result[0].id;
					}
				} catch (error) {
					console.error(`Error en invoice_mapping para valor ${sourceValue}:`, error.message);
				}
				return sourceValue;
			}

			// Mapeo de valores específicos (value_mapping)
			if (transformationType === TransformationType.VALUE_MAPPING) {
				if (!transformationConfig?.mappings) {
					return sourceValue;
				}

				const mappedValue = transformationConfig.mappings[sourceValue];
				return mappedValue || transformationConfig.default_value || sourceValue;
			}

			// Lookup genérico en tabla
			if (transformationType === TransformationType.LOOKUP_TABLE) {
				if (!transformationConfig?.table || !transformationConfig?.source_column || !transformationConfig?.target_column) {
					console.warn('Configuración incompleta para lookup_table');
					return sourceValue;
				}

				try {
					const table = transformationConfig.table;
					const sourceColumn = transformationConfig.source_column;
					const targetColumn = transformationConfig.target_column;
					const filterColumn = transformationConfig.filter_column;
					const filterValue = transformationConfig.filter_value;

					let query = `SELECT ${targetColumn} FROM ${table} WHERE ${sourceColumn} = $1`;
					const params: any[] = [sourceValue];

					if (filterColumn && filterValue) {
						query += ` AND ${filterColumn} = $2`;
						params.push(filterValue);
					}

					query += ' LIMIT 1';

					const result = await this.companyRepository.query(query, params);

					if (result && result.length > 0) {
						return result[0][targetColumn];
					}
				} catch (error) {
					console.error(`Error en lookup_table para valor ${sourceValue}:`, error.message);
				}
				return sourceValue;
			}

			// Función personalizada (placeholder)
			if (transformationType === TransformationType.CUSTOM_FUNCTION) {
				return sourceValue;
			}

			// Por defecto, retornar el valor original
			return sourceValue;
		} catch (error) {
			console.error(`Error en transformación ${transformationType} para valor ${sourceValue}:`, error.message);
			// En caso de error, retornar el valor original
			return sourceValue;
		}
	}

	/**
	 * Transforma el estado de pago de Odoo a Sapira
	 * Replica la función transformPaymentState del frontend
	 */
	transformPaymentState(odooState: string): string {
		const stateMapping: Record<string, string> = {
			not_paid: 'Enviada',
			in_payment: 'Enviada',
			paid: 'Pagada',
			partial: 'Enviada',
			reversed: 'Enviada',
			invoicing_legacy: 'Pagada',
		};

		return stateMapping[odooState] || 'Enviada';
	}
}
