import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OdooConnection } from '../entities/odoo-connection.entity';
import { OdooProvider } from '../odoo.provider';

export interface FiscalPositionTaxMapping {
	id: number;
	tax_src_id: number | null;
	tax_src_name: string | null;
	tax_dest_id: number;
	tax_dest_name: string;
	tax_dest_amount: number;
	tax_dest_type: string;
}

export interface CompleteTaxMapping {
	id: number;
	tax_src_id: number | null;
	tax_src_name: string | null;
	tax_src_amount: number | null;
	tax_src_type: string | null;
	tax_dest_id: number | null;
	tax_dest_name: string | null;
	tax_dest_amount: number | null;
	tax_dest_type: string | null;
}

export interface FiscalPositionComplete {
	id: number;
	name: string;
	company_id: number;
	company_name: string;
	country_id: number | null;
	country_name: string | null;
	auto_apply: boolean;
	vat_required: boolean;
	complete_tax_mappings: CompleteTaxMapping[];
}

export interface FiscalPositionTax {
	id: number;
	name: string;
	amount: number;
	type_tax_use: string;
	company_id: number;
	company_name: string;
}

export interface FiscalPosition {
	id: number;
	name: string;
	company_id: number;
	company_name: string;
	country_id?: number;
	country_name?: string;
	tax_mappings: FiscalPositionTaxMapping[];
	tax_ids: FiscalPositionTax[];
}

export interface GetFiscalPositionsResponseDto {
	success: boolean;
	fiscal_positions: FiscalPosition[];
	total: number;
	message?: string;
}

export interface TaxDetail {
	id: number;
	name: string;
	amount: number;
	type_tax_use: string;
}

export interface CompanyDefaultTaxes {
	company_id: number;
	company_name: string;
	sale_tax: TaxDetail | null;
	reteica_tax: TaxDetail | null;
	retefuente_tax: TaxDetail | null;
	reteiva_tax: TaxDetail | null;
}

export interface PartnerApplicableTaxes {
	partner_id: number;
	partner_name: string;
	company_id: number;
	company_name: string;
	fiscal_position_id: number | null;
	fiscal_position_name: string | null;
	applicable_taxes: TaxDetail[];
	has_fiscal_position: boolean;
}

export interface TaxInfo {
	id: number;
	name: string;
	amount: number;
	type_tax_use: string;
	company_id: number;
	company_name: string;
	active: boolean;
	price_include: boolean;
	include_base_amount: boolean;
}

export interface GetTaxesResponseDto {
	success: boolean;
	taxes: TaxInfo[];
	total: number;
	message?: string;
}

@Injectable()
export class FiscalPositionsService {
	private readonly logger = new Logger(FiscalPositionsService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>
	) {}

	private async getOdooConnectionByHoldingId(holdingId: string): Promise<OdooConnection | null> {
		return await this.odooConnectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});
	}

	async getFiscalPositions(holdingId: string, companyId?: number): Promise<GetFiscalPositionsResponseDto> {
		try {
			this.logger.log(`🔍 Consultando posiciones fiscales de Odoo - Holding: ${holdingId}, Company: ${companyId || 'todas'}`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			const domain: any[] = companyId ? [['company_id', '=', companyId]] : [];

			const fiscalPositionIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.fiscal.position',
				'search',
				[domain],
			]);

			if (!fiscalPositionIds || fiscalPositionIds.length === 0) {
				this.logger.warn('No se encontraron posiciones fiscales');
				return {
					success: true,
					fiscal_positions: [],
					total: 0,
					message: 'No se encontraron posiciones fiscales',
				};
			}

			this.logger.log(`📋 Encontradas ${fiscalPositionIds.length} posiciones fiscales`);

			const fiscalPositionsData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.fiscal.position',
				'read',
				[fiscalPositionIds, ['id', 'name', 'company_id', 'country_id', 'tax_ids']],
			]);

			const fiscalPositions: FiscalPosition[] = [];

			for (const fp of fiscalPositionsData) {
				const taxMappingIds = Array.isArray(fp.tax_ids) ? fp.tax_ids : [];

				let taxMappings: FiscalPositionTaxMapping[] = [];
				let taxes: FiscalPositionTax[] = [];

				if (taxMappingIds.length > 0) {
					// Obtener los mapeos de impuestos (tax_src_id -> tax_dest_id)
					const taxMappingsData = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.fiscal.position.tax',
						'read',
						[taxMappingIds, ['id', 'tax_src_id', 'tax_dest_id']],
					]);

					// Obtener IDs únicos de impuestos destino
					const destTaxIds = taxMappingsData
						.map((mapping: any) =>
							mapping.tax_dest_id ? (Array.isArray(mapping.tax_dest_id) ? mapping.tax_dest_id[0] : mapping.tax_dest_id) : null
						)
						.filter((id: number | null) => id !== null);

					// Obtener IDs únicos de impuestos origen (pueden ser null)
					const srcTaxIds = taxMappingsData
						.map((mapping: any) =>
							mapping.tax_src_id ? (Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id) : null
						)
						.filter((id: number | null) => id !== null);

					const allTaxIds = [...new Set([...destTaxIds, ...srcTaxIds])];

					// Obtener datos de todos los impuestos
					const taxesDataMap = new Map<number, any>();
					if (allTaxIds.length > 0) {
						const taxesData = await objectClient.methodCall('execute_kw', [
							connection.database_name,
							uid,
							connection.api_key,
							'account.tax',
							'read',
							[allTaxIds, ['id', 'name', 'amount', 'type_tax_use', 'company_id']],
						]);

						taxesData.forEach((tax: any) => {
							taxesDataMap.set(tax.id, tax);
						});
					}

					// Construir mapeos con información completa
					taxMappings = taxMappingsData.map((mapping: any) => {
						const srcTaxId = mapping.tax_src_id ? (Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id) : null;
						const destTaxId = mapping.tax_dest_id
							? Array.isArray(mapping.tax_dest_id)
								? mapping.tax_dest_id[0]
								: mapping.tax_dest_id
							: null;

						const srcTax = srcTaxId ? taxesDataMap.get(srcTaxId) : null;
						const destTax = destTaxId ? taxesDataMap.get(destTaxId) : null;

						return {
							id: mapping.id,
							tax_src_id: srcTaxId,
							tax_src_name: srcTax ? srcTax.name : null,
							tax_dest_id: destTaxId || 0,
							tax_dest_name: destTax ? destTax.name : '',
							tax_dest_amount: destTax ? destTax.amount || 0 : 0,
							tax_dest_type: destTax ? destTax.type_tax_use || 'sale' : 'sale',
						};
					});

					// Construir lista de impuestos destino únicos
					taxes = destTaxIds.map((taxId: number) => {
						const tax = taxesDataMap.get(taxId);
						return {
							id: tax.id,
							name: tax.name,
							amount: tax.amount || 0,
							type_tax_use: tax.type_tax_use || 'sale',
							company_id: Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id,
							company_name: Array.isArray(tax.company_id) ? tax.company_id[1] : '',
						};
					});
				}

				fiscalPositions.push({
					id: fp.id,
					name: fp.name,
					company_id: Array.isArray(fp.company_id) ? fp.company_id[0] : fp.company_id,
					company_name: Array.isArray(fp.company_id) ? fp.company_id[1] : '',
					country_id: Array.isArray(fp.country_id) ? fp.country_id[0] : undefined,
					country_name: Array.isArray(fp.country_id) ? fp.country_id[1] : undefined,
					tax_mappings: taxMappings,
					tax_ids: taxes,
				});
			}

			this.logger.log(`✅ Procesadas ${fiscalPositions.length} posiciones fiscales con sus impuestos`);

			return {
				success: true,
				fiscal_positions: fiscalPositions,
				total: fiscalPositions.length,
			};
		} catch (error) {
			this.logger.error(`❌ Error consultando posiciones fiscales: ${error.message}`, error.stack);
			return {
				success: false,
				fiscal_positions: [],
				total: 0,
				message: `Error: ${error.message}`,
			};
		}
	}

	async getFiscalPositionById(holdingId: string, fiscalPositionId: number): Promise<FiscalPosition | null> {
		try {
			this.logger.log(`🔍 Consultando posición fiscal ${fiscalPositionId} de Odoo`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			const fiscalPositionsData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.fiscal.position',
				'read',
				[[fiscalPositionId], ['id', 'name', 'company_id', 'country_id', 'tax_ids']],
			]);

			if (!fiscalPositionsData || fiscalPositionsData.length === 0) {
				this.logger.warn(`Posición fiscal ${fiscalPositionId} no encontrada`);
				return null;
			}

			const fp = fiscalPositionsData[0];
			const taxMappingIds = Array.isArray(fp.tax_ids) ? fp.tax_ids : [];

			let taxMappings: FiscalPositionTaxMapping[] = [];
			let taxes: FiscalPositionTax[] = [];

			if (taxMappingIds.length > 0) {
				// Obtener los mapeos de impuestos (tax_src_id -> tax_dest_id)
				const taxMappingsData = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.fiscal.position.tax',
					'read',
					[taxMappingIds, ['id', 'tax_src_id', 'tax_dest_id']],
				]);

				// Obtener IDs únicos de impuestos destino
				const destTaxIds = taxMappingsData
					.map((mapping: any) =>
						mapping.tax_dest_id ? (Array.isArray(mapping.tax_dest_id) ? mapping.tax_dest_id[0] : mapping.tax_dest_id) : null
					)
					.filter((id: number | null) => id !== null);

				// Obtener IDs únicos de impuestos origen (pueden ser null)
				const srcTaxIds = taxMappingsData
					.map((mapping: any) =>
						mapping.tax_src_id ? (Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id) : null
					)
					.filter((id: number | null) => id !== null);

				const allTaxIds = [...new Set([...destTaxIds, ...srcTaxIds])];

				// Obtener datos de todos los impuestos
				const taxesDataMap = new Map<number, any>();
				if (allTaxIds.length > 0) {
					const taxesData = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.tax',
						'read',
						[allTaxIds, ['id', 'name', 'amount', 'type_tax_use', 'company_id']],
					]);

					taxesData.forEach((tax: any) => {
						taxesDataMap.set(tax.id, tax);
					});
				}

				// Construir mapeos con información completa
				taxMappings = taxMappingsData.map((mapping: any) => {
					const srcTaxId = mapping.tax_src_id ? (Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id) : null;
					const destTaxId = mapping.tax_dest_id
						? Array.isArray(mapping.tax_dest_id)
							? mapping.tax_dest_id[0]
							: mapping.tax_dest_id
						: null;

					const srcTax = srcTaxId ? taxesDataMap.get(srcTaxId) : null;
					const destTax = destTaxId ? taxesDataMap.get(destTaxId) : null;

					return {
						id: mapping.id,
						tax_src_id: srcTaxId,
						tax_src_name: srcTax ? srcTax.name : null,
						tax_dest_id: destTaxId || 0,
						tax_dest_name: destTax ? destTax.name : '',
						tax_dest_amount: destTax ? destTax.amount || 0 : 0,
						tax_dest_type: destTax ? destTax.type_tax_use || 'sale' : 'sale',
					};
				});

				// Construir lista de impuestos destino únicos
				taxes = destTaxIds.map((taxId: number) => {
					const tax = taxesDataMap.get(taxId);
					return {
						id: tax.id,
						name: tax.name,
						amount: tax.amount || 0,
						type_tax_use: tax.type_tax_use || 'sale',
						company_id: Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id,
						company_name: Array.isArray(tax.company_id) ? tax.company_id[1] : '',
					};
				});
			}

			const fiscalPosition: FiscalPosition = {
				id: fp.id,
				name: fp.name,
				company_id: Array.isArray(fp.company_id) ? fp.company_id[0] : fp.company_id,
				company_name: Array.isArray(fp.company_id) ? fp.company_id[1] : '',
				country_id: Array.isArray(fp.country_id) ? fp.country_id[0] : undefined,
				country_name: Array.isArray(fp.country_id) ? fp.country_id[1] : undefined,
				tax_mappings: taxMappings,
				tax_ids: taxes,
			};

			this.logger.log(`✅ Posición fiscal ${fiscalPositionId} encontrada: ${fiscalPosition.name} con ${taxes.length} impuestos`);

			return fiscalPosition;
		} catch (error) {
			this.logger.error(`❌ Error consultando posición fiscal ${fiscalPositionId}: ${error.message}`, error.stack);
			return null;
		}
	}

	async getCompanyDefaultTaxes(holdingId: string, companyId: number): Promise<CompanyDefaultTaxes | null> {
		try {
			this.logger.log(`🔍 Consultando impuestos por defecto de compañía ${companyId} en Odoo`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			let companies;
			let hasColombianFields = true;

			try {
				companies = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'res.company',
					'read',
					[[companyId]],
					{
						fields: [
							'id',
							'name',
							'account_sale_tax_id',
							'l10n_co_edi_reteica_tax_id',
							'l10n_co_edi_retefuente_tax_id',
							'l10n_co_edi_reteiva_tax_id',
						],
					},
				]);
			} catch (error) {
				if (error.message && error.message.includes('Invalid field')) {
					this.logger.warn('⚠️ Campos de retenciones colombianas no disponibles, usando solo account_sale_tax_id');
					hasColombianFields = false;

					companies = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'res.company',
						'read',
						[[companyId]],
						{
							fields: ['id', 'name', 'account_sale_tax_id'],
						},
					]);
				} else {
					throw error;
				}
			}

			if (!companies || companies.length === 0) {
				this.logger.warn(`Compañía ${companyId} no encontrada en Odoo`);
				return null;
			}

			const company = companies[0];

			const saleTaxId = Array.isArray(company.account_sale_tax_id) ? company.account_sale_tax_id[0] : company.account_sale_tax_id;
			const reteicaTaxId =
				hasColombianFields && company.l10n_co_edi_reteica_tax_id
					? Array.isArray(company.l10n_co_edi_reteica_tax_id)
						? company.l10n_co_edi_reteica_tax_id[0]
						: company.l10n_co_edi_reteica_tax_id
					: null;
			const retefuenteTaxId =
				hasColombianFields && company.l10n_co_edi_retefuente_tax_id
					? Array.isArray(company.l10n_co_edi_retefuente_tax_id)
						? company.l10n_co_edi_retefuente_tax_id[0]
						: company.l10n_co_edi_retefuente_tax_id
					: null;
			const reteivaTaxId =
				hasColombianFields && company.l10n_co_edi_reteiva_tax_id
					? Array.isArray(company.l10n_co_edi_reteiva_tax_id)
						? company.l10n_co_edi_reteiva_tax_id[0]
						: company.l10n_co_edi_reteiva_tax_id
					: null;

			const allTaxIds = [saleTaxId, reteicaTaxId, retefuenteTaxId, reteivaTaxId].filter((id) => typeof id === 'number');

			const taxesDataMap = new Map<number, any>();
			if (allTaxIds.length > 0) {
				const taxesData = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.tax',
					'read',
					[allTaxIds],
					{
						fields: ['id', 'name', 'amount', 'type_tax_use'],
					},
				]);

				taxesData.forEach((tax: any) => {
					taxesDataMap.set(tax.id, tax);
				});
			}

			const buildTaxDetail = (taxId: number | null): TaxDetail | null => {
				if (!taxId) return null;
				const tax = taxesDataMap.get(taxId);
				if (!tax) return null;
				return {
					id: tax.id,
					name: tax.name,
					amount: tax.amount || 0,
					type_tax_use: tax.type_tax_use || 'sale',
				};
			};

			const result: CompanyDefaultTaxes = {
				company_id: company.id,
				company_name: company.name,
				sale_tax: buildTaxDetail(saleTaxId),
				reteica_tax: buildTaxDetail(reteicaTaxId),
				retefuente_tax: buildTaxDetail(retefuenteTaxId),
				reteiva_tax: buildTaxDetail(reteivaTaxId),
			};

			this.logger.log(`✅ Impuestos por defecto de compañía ${company.name} obtenidos`);

			return result;
		} catch (error) {
			this.logger.error(`❌ Error consultando impuestos por defecto de compañía ${companyId}: ${error.message}`, error.stack);
			return null;
		}
	}

	async getPartnerApplicableTaxes(holdingId: string, partnerId: number): Promise<PartnerApplicableTaxes | null> {
		try {
			this.logger.log(`🔍 Consultando impuestos aplicables al partner ${partnerId} en Odoo`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Primero obtener el partner para saber su company_id
			const partnerBasic = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.partner',
				'search_read',
				[[['id', '=', partnerId]]],
				{
					fields: ['id', 'name', 'company_id'],
					limit: 1,
				},
			]);

			if (!partnerBasic || partnerBasic.length === 0) {
				this.logger.warn(`Partner ${partnerId} no encontrado en Odoo`);
				return null;
			}

			const partnerCompanyId = Array.isArray(partnerBasic[0].company_id) ? partnerBasic[0].company_id[0] : partnerBasic[0].company_id;

			// Ahora leer con el contexto correcto para obtener property_account_position_id
			const partners = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.partner',
				'read',
				[[partnerId]],
				{
					fields: ['id', 'name', 'company_id', 'property_account_position_id'],
					context: { force_company: partnerCompanyId },
				},
			]);

			console.log('partners =====================> ', partners);

			if (!partners || partners.length === 0) {
				this.logger.warn(`Partner ${partnerId} no encontrado en Odoo`);
				return null;
			}

			const partner = partners[0];
			const partnerCompanyName = Array.isArray(partner.company_id) ? partner.company_id[1] : '';

			// Odoo retorna false cuando el campo relacional está vacío
			const fiscalPositionData = partner.property_account_position_id;
			const fiscalPositionId =
				fiscalPositionData && fiscalPositionData !== false
					? Array.isArray(fiscalPositionData)
						? fiscalPositionData[0]
						: fiscalPositionData
					: null;
			const fiscalPositionName = fiscalPositionData && Array.isArray(fiscalPositionData) ? fiscalPositionData[1] : null;

			let applicableTaxes: TaxDetail[] = [];

			if (fiscalPositionId) {
				this.logger.log(`📋 Partner tiene posición fiscal: ${fiscalPositionName} (ID: ${fiscalPositionId})`);

				const fiscalPositions = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.fiscal.position',
					'read',
					[[fiscalPositionId]],
					{ fields: ['id', 'name', 'tax_ids'] },
				]);

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
							{ fields: ['id', 'name', 'amount', 'type_tax_use'] },
						]);

						applicableTaxes = taxes.map((tax: any) => ({
							id: tax.id,
							name: tax.name,
							amount: tax.amount || 0,
							type_tax_use: tax.type_tax_use || 'sale',
						}));
					}
				}
			} else {
				this.logger.log(`📋 Partner NO tiene posición fiscal, usando impuestos por defecto de compañía ${partnerCompanyId}`);

				if (partnerCompanyId) {
					const companyTaxes = await this.getCompanyDefaultTaxes(holdingId, partnerCompanyId);
					if (companyTaxes) {
						if (companyTaxes.sale_tax) applicableTaxes.push(companyTaxes.sale_tax);
						if (companyTaxes.reteica_tax) applicableTaxes.push(companyTaxes.reteica_tax);
						if (companyTaxes.retefuente_tax) applicableTaxes.push(companyTaxes.retefuente_tax);
						if (companyTaxes.reteiva_tax) applicableTaxes.push(companyTaxes.reteiva_tax);
					}
				}
			}

			const result: PartnerApplicableTaxes = {
				partner_id: partner.id,
				partner_name: partner.name,
				company_id: partnerCompanyId || 0,
				company_name: partnerCompanyName,
				fiscal_position_id: fiscalPositionId || null,
				fiscal_position_name: fiscalPositionName,
				applicable_taxes: applicableTaxes,
				has_fiscal_position: !!fiscalPositionId,
			};

			this.logger.log(`✅ Impuestos aplicables al partner ${partner.name}: ${applicableTaxes.length} impuestos`);

			return result;
		} catch (error) {
			this.logger.error(`❌ Error consultando impuestos aplicables al partner ${partnerId}: ${error.message}`, error.stack);
			return null;
		}
	}

	async getFiscalPositionComplete(holdingId: string, fiscalPositionId: number): Promise<FiscalPositionComplete | null> {
		try {
			this.logger.log(`🔍 Consultando posición fiscal completa ${fiscalPositionId} con todos los mapeos de impuestos`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Leer la posición fiscal
			const fiscalPositionsData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.fiscal.position',
				'read',
				[[fiscalPositionId]],
				{
					fields: ['id', 'name', 'company_id', 'country_id', 'auto_apply', 'vat_required', 'tax_ids'],
				},
			]);

			if (!fiscalPositionsData || fiscalPositionsData.length === 0) {
				this.logger.warn(`Posición fiscal ${fiscalPositionId} no encontrada`);
				return null;
			}

			const fp = fiscalPositionsData[0];
			const taxMappingIds = Array.isArray(fp.tax_ids) ? fp.tax_ids : [];

			let completeTaxMappings: CompleteTaxMapping[] = [];

			if (taxMappingIds.length > 0) {
				// Obtener todos los mapeos de impuestos
				const taxMappingsData = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.fiscal.position.tax',
					'read',
					[taxMappingIds],
					{ fields: ['id', 'tax_src_id', 'tax_dest_id'] },
				]);

				// Recolectar todos los IDs de impuestos (src y dest)
				const allTaxIds = new Set<number>();
				taxMappingsData.forEach((mapping: any) => {
					if (mapping.tax_src_id) {
						const srcId = Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id;
						if (srcId) allTaxIds.add(srcId);
					}
					if (mapping.tax_dest_id) {
						const destId = Array.isArray(mapping.tax_dest_id) ? mapping.tax_dest_id[0] : mapping.tax_dest_id;
						if (destId) allTaxIds.add(destId);
					}
				});

				// Obtener información completa de todos los impuestos
				const taxesDataMap = new Map<number, any>();
				if (allTaxIds.size > 0) {
					const taxesData = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.tax',
						'read',
						[Array.from(allTaxIds)],
						{ fields: ['id', 'name', 'amount', 'type_tax_use'] },
					]);

					taxesData.forEach((tax: any) => {
						taxesDataMap.set(tax.id, tax);
					});
				}

				// Construir mapeos completos con información de src y dest
				completeTaxMappings = taxMappingsData.map((mapping: any) => {
					const srcTaxId = mapping.tax_src_id ? (Array.isArray(mapping.tax_src_id) ? mapping.tax_src_id[0] : mapping.tax_src_id) : null;
					const destTaxId = mapping.tax_dest_id
						? Array.isArray(mapping.tax_dest_id)
							? mapping.tax_dest_id[0]
							: mapping.tax_dest_id
						: null;

					const srcTax = srcTaxId ? taxesDataMap.get(srcTaxId) : null;
					const destTax = destTaxId ? taxesDataMap.get(destTaxId) : null;

					return {
						id: mapping.id,
						tax_src_id: srcTaxId,
						tax_src_name: srcTax ? srcTax.name : null,
						tax_src_amount: srcTax ? srcTax.amount || 0 : null,
						tax_src_type: srcTax ? srcTax.type_tax_use || 'sale' : null,
						tax_dest_id: destTaxId,
						tax_dest_name: destTax ? destTax.name : null,
						tax_dest_amount: destTax ? destTax.amount || 0 : null,
						tax_dest_type: destTax ? destTax.type_tax_use || 'sale' : null,
					};
				});
			}

			const result: FiscalPositionComplete = {
				id: fp.id,
				name: fp.name,
				company_id: Array.isArray(fp.company_id) ? fp.company_id[0] : fp.company_id,
				company_name: Array.isArray(fp.company_id) ? fp.company_id[1] : '',
				country_id: fp.country_id ? (Array.isArray(fp.country_id) ? fp.country_id[0] : fp.country_id) : null,
				country_name: fp.country_id && Array.isArray(fp.country_id) ? fp.country_id[1] : null,
				auto_apply: fp.auto_apply || false,
				vat_required: fp.vat_required || false,
				complete_tax_mappings: completeTaxMappings,
			};

			this.logger.log(`✅ Posición fiscal completa "${result.name}" con ${completeTaxMappings.length} mapeos de impuestos`);

			return result;
		} catch (error) {
			this.logger.error(`❌ Error consultando posición fiscal completa ${fiscalPositionId}: ${error.message}`, error.stack);
			return null;
		}
	}

	async getTaxesByIds(holdingId: string, taxIds: number[]): Promise<GetTaxesResponseDto> {
		try {
			this.logger.log(`🔍 Consultando ${taxIds.length} impuestos de Odoo: [${taxIds.join(', ')}]`);

			if (!taxIds || taxIds.length === 0) {
				return {
					success: true,
					taxes: [],
					total: 0,
					message: 'No se proporcionaron IDs de impuestos',
				};
			}

			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Consultar los impuestos
			const taxesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[taxIds],
				{
					fields: ['id', 'name', 'amount', 'type_tax_use', 'company_id', 'active', 'price_include', 'include_base_amount'],
				},
			]);

			const taxes: TaxInfo[] = taxesData.map((tax: any) => ({
				id: tax.id,
				name: tax.name,
				amount: tax.amount || 0,
				type_tax_use: tax.type_tax_use || 'sale',
				company_id: Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id,
				company_name: Array.isArray(tax.company_id) ? tax.company_id[1] : '',
				active: tax.active !== undefined ? tax.active : true,
				price_include: tax.price_include || false,
				include_base_amount: tax.include_base_amount || false,
			}));

			this.logger.log(`✅ Consultados ${taxes.length} impuestos de Odoo`);

			return {
				success: true,
				taxes,
				total: taxes.length,
			};
		} catch (error) {
			this.logger.error(`❌ Error consultando impuestos: ${error.message}`, error.stack);
			return {
				success: false,
				taxes: [],
				total: 0,
				message: `Error: ${error.message}`,
			};
		}
	}
}
