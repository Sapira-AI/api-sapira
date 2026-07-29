import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
	SalesforceFieldMapping,
	SalesforceFieldMappingObjectType,
	SalesforceFieldTransformationKey,
} from '../entities/salesforce-field-mapping.entity';
import { SalesforceQuoteTypeMapping } from '../entities/salesforce-quote-type-mapping.entity';
import {
	buildCustomFields,
	formatAddress,
	generateClientNumber,
	isoToCountryName,
	isRecurring,
	normalizeTaxId,
	parseSalesforceDate,
	transformBillingMethod,
	transformToBoolean,
} from '../utils/salesforce-transformers';

import { SalesforceMappingService } from './salesforce-mapping.service';

interface MappingContext {
	opportunity?: Record<string, any>;
	lineItem?: Record<string, any>;
}

@Injectable()
export class SalesforceFieldMappingEngineService {
	constructor(
		@InjectRepository(SalesforceFieldMapping)
		private readonly fieldMappingRepository: Repository<SalesforceFieldMapping>,
		@InjectRepository(SalesforceQuoteTypeMapping)
		private readonly quoteTypeMappingRepository: Repository<SalesforceQuoteTypeMapping>,
		private readonly salesforceMappingService: SalesforceMappingService
	) {}

	async getActiveMappings(holdingId: string, objectType: SalesforceFieldMappingObjectType): Promise<SalesforceFieldMapping[]> {
		await this.salesforceMappingService.ensureDefaultFieldMappings(holdingId, objectType);

		return this.fieldMappingRepository.find({
			where: {
				holding_id: holdingId,
				object_type: objectType,
				is_active: true,
			},
			order: {
				sapira_field: 'ASC',
			},
		});
	}

	async buildMappedRecord(
		holdingId: string,
		objectType: SalesforceFieldMappingObjectType,
		sourceRecord: Record<string, any>,
		context: MappingContext = {}
	): Promise<Record<string, any>> {
		const mappings = await this.getActiveMappings(holdingId, objectType);
		const result: Record<string, any> = {};

		for (const mapping of mappings) {
			const rawValue = this.extractSourceValue(sourceRecord, mapping.salesforce_field);
			const transformedValue = await this.transformMappedValue(holdingId, mapping, rawValue, sourceRecord, context);

			if (transformedValue === undefined || transformedValue === null || transformedValue === '') {
				continue;
			}

			result[mapping.sapira_field] = transformedValue;
		}

		return result;
	}

	private extractSourceValue(sourceRecord: Record<string, any>, path: string): any {
		if (!path) {
			return null;
		}

		if (path === 'custom_fields') {
			return path;
		}

		if (path.includes(',')) {
			return path.split(',').map((segment) => this.extractSourceValue(sourceRecord, segment.trim()));
		}

		return path.split('.').reduce<any>((current, key) => {
			if (current === null || current === undefined) {
				return null;
			}

			return this.readPathSegment(current, key);
		}, sourceRecord);
	}

	private readPathSegment(current: any, segment: string): any {
		const match = segment.match(/^([^\[\]]+)(?:\[(\d+)\])?$/);
		if (!match) {
			return current?.[segment];
		}

		const [, propertyName, arrayIndex] = match;
		const nextValue = current?.[propertyName];
		if (arrayIndex === undefined) {
			return nextValue;
		}

		if (!Array.isArray(nextValue)) {
			return null;
		}

		return nextValue[Number(arrayIndex)] ?? null;
	}

	private async transformMappedValue(
		holdingId: string,
		mapping: SalesforceFieldMapping,
		rawValue: any,
		sourceRecord: Record<string, any>,
		context: MappingContext
	): Promise<any> {
		const sapiraField = mapping.sapira_field;
		const fallbackValue = mapping.default_value ?? null;
		const transformationKey = this.resolveTransformationKey(mapping);

		switch (transformationKey) {
			case 'client_number_fallback':
				return generateClientNumber(sourceRecord.Id, rawValue || fallbackValue || undefined);
			case 'country_name':
				return isoToCountryName(rawValue || fallbackValue);
			case 'legal_address_concat': {
				const values = Array.isArray(rawValue) ? rawValue : [rawValue];
				return formatAddress(values[0], values[1], values[2], values[3], values[4]);
			}
			case 'quote_type_mapping':
				return this.resolveQuoteType(holdingId, rawValue || fallbackValue);
			case 'quote_date_with_close_fallback': {
				const created = parseSalesforceDate(rawValue || undefined);
				return created || parseSalesforceDate(sourceRecord.CloseDate || undefined);
			}
			case 'salesforce_date':
				return parseSalesforceDate(rawValue || undefined);
			case 'salesforce_boolean':
				return transformToBoolean(rawValue);
			case 'recurring_flag':
				return isRecurring(rawValue || undefined);
			case 'billing_method':
				return transformBillingMethod(rawValue || context.opportunity?.Forma_de_pago__c || fallbackValue || undefined);
			case 'billing_frequency':
				return (
					rawValue || context.opportunity?.Account?.Per_odo_de_facturaci_n__c || context.opportunity?.Modalidad_de_pago__c || fallbackValue
				);
			case 'custom_fields_bundle':
				return buildCustomFields(context.lineItem || sourceRecord, context.opportunity?.Account?.Lista_de_Precio__r?.Tipo__c || null);
			case 'tax_id_normalized':
				return normalizeTaxId(rawValue || fallbackValue);
			case 'direct':
			default:
				return this.resolveDirectValue(sapiraField, rawValue, sourceRecord, fallbackValue);
		}
	}

	private resolveTransformationKey(mapping: SalesforceFieldMapping): SalesforceFieldTransformationKey {
		if (mapping.transformation_key) {
			return mapping.transformation_key;
		}

		switch (mapping.sapira_field) {
			case 'client_number':
				return 'client_number_fallback';
			case 'country':
				return 'country_name';
			case 'legal_address':
				return 'legal_address_concat';
			case 'quote_type':
				return 'quote_type_mapping';
			case 'quote_date':
				return 'quote_date_with_close_fallback';
			case 'booking_date':
			case 'start_date':
			case 'end_date':
				return 'salesforce_date';
			case 'requires_contract_document':
			case 'requires_references_for_billing':
				return 'salesforce_boolean';
			case 'is_recurring':
				return 'recurring_flag';
			case 'billing_method':
				return 'billing_method';
			case 'billing_frequency':
				return 'billing_frequency';
			case 'custom_fields':
				return 'custom_fields_bundle';
			case 'tax_id':
				return 'tax_id_normalized';
			default:
				return 'direct';
		}
	}

	private resolveDirectValue(sapiraField: string, rawValue: any, sourceRecord: Record<string, any>, fallbackValue?: string | null): Promise<any> {
		switch (sapiraField) {
			case 'salesforce_account_id':
			case 'salesforce_opportunity_id':
			case 'salesforce_line_item_id':
			case 'salesforce_product_id':
			case 'quote_item_number':
				return Promise.resolve(rawValue || sourceRecord.Id || fallbackValue);
			default:
				if (rawValue === null || rawValue === undefined || rawValue === '') {
					return Promise.resolve(fallbackValue);
				}

				return Promise.resolve(rawValue);
		}
	}

	private async resolveQuoteType(holdingId: string, salesforceType?: string | null): Promise<string> {
		if (!salesforceType) {
			return 'NewBusiness';
		}

		const mapping = await this.quoteTypeMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_type: salesforceType,
				is_active: true,
			},
		});

		return mapping?.sapira_quote_type || salesforceType || 'NewBusiness';
	}
}
