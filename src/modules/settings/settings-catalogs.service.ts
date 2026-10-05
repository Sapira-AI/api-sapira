import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { normalizeQuoteType, QUOTE_TYPE_CODES, QUOTE_TYPE_LABELS, type QuoteTypeCode } from '@/modules/quotes/quote-status';

import { MASTER_DATA_CATEGORIES } from './dtos/catalogs.dto';
import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type {
	CreateMasterDataDto,
	CreateNamedDto,
	CreateSellerDto,
	MasterDataCategory,
	MergeSellersDto,
	UpdateMasterDataDto,
	UpdateNamedDto,
	UpdateSellerDto,
} from './dtos/catalogs.dto';

/** Dónde se usa un valor de datos maestros (desglose para el tooltip del front). */
export type MasterDataUsage = { contracts: number; quotes: number; subscriptions: number; invoices: number; quantities: number; clients: number };
type UsageKey = keyof MasterDataUsage;

const emptyUsage = (): MasterDataUsage => ({ contracts: 0, quotes: 0, subscriptions: 0, invoices: 0, quantities: 0, clients: 0 });

/**
 * Uso de un valor de datos maestros: las tablas guardan el **texto** (no hay FK), así que se cuenta por coincidencia exacta dentro del
 * holding (columnas verificadas en `information_schema`, 03-10). Cada consulta recibe `$1` = holding y `$2` = valores.
 */
const usageSql = (table: string, column: string) =>
	`SELECT ${column} AS value, count(*) AS n FROM ${table} WHERE holding_id = $1 AND ${column} = ANY($2::text[]) GROUP BY 1`;

const MASTER_DATA_USAGE: Record<MasterDataCategory, { key: UsageKey; sql: string }[]> = {
	item_types: [
		{ key: 'contracts', sql: usageSql('contract_items', 'item_type') },
		{ key: 'quotes', sql: usageSql('quote_items', 'item_type') },
		{ key: 'subscriptions', sql: usageSql('subscription_items', 'item_type') },
		{ key: 'invoices', sql: usageSql('invoice_items_legacy', 'item_type') },
	],
	units_of_measure: [
		{ key: 'contracts', sql: usageSql('contract_items', 'unit_of_measure') },
		{ key: 'quotes', sql: usageSql('quote_items', 'unit_of_measure') },
		{ key: 'invoices', sql: usageSql('invoice_items', 'unit_of_measure') },
		{ key: 'invoices', sql: usageSql('invoice_items_legacy', 'unit_of_measure') },
		{ key: 'quantities', sql: usageSql('quantities', 'unit_of_measure') },
		{ key: 'quantities', sql: usageSql('sapira_quantity_imports', 'unit_of_measure') },
	],
	// Ronda 3: texto exacto en las columnas de clientes (verificadas en `information_schema`, 03-10).
	markets: [{ key: 'clients', sql: usageSql('clients', 'market') }],
	segments: [{ key: 'clients', sql: usageSql('clients', 'segment') }],
	industries: [{ key: 'clients', sql: usageSql('clients', 'industry') }],
};

const totalUsage = (usage: MasterDataUsage | undefined) => (usage ? Object.values(usage).reduce((sum, n) => sum + n, 0) : 0);

const sellerDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	email: String(row.email ?? ''),
	phone: (row.phone as string | null) ?? null,
	is_active: row.is_active === true,
	/** Dueño del CRM que corresponde a este vendedor (Integraciones v2, D7). */
	crm_owner_id: (row.crm_owner_id as string | null) ?? null,
	created_at: row.created_at,
	in_use: toCount(row.in_use),
});

const churnReasonDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	is_active: row.is_active === true,
	created_at: row.created_at,
	updated_at: row.updated_at,
	in_use: toCount(row.in_use),
});

/** Efecto guía de cada tipo de negocio en el MRR (el movimiento real lo calcula Métricas desde el cambio del contrato). */
export const BUSINESS_TYPE_EFFECTS: Record<QuoteTypeCode, { mrr_effect: string; mrr_effect_label: string; description: string }> = {
	new_business: {
		mrr_effect: 'new',
		mrr_effect_label: 'Nuevo',
		description: 'Cliente sin contratos vigentes: crea un contrato nuevo y su MRR entra como Nuevo',
	},
	upsell: {
		mrr_effect: 'expansion',
		mrr_effect_label: 'Expansión',
		description: 'Más cantidad o precio de lo que el cliente ya tiene: el aumento de MRR cuenta como Expansión',
	},
	cross_sell: {
		mrr_effect: 'expansion',
		mrr_effect_label: 'Expansión',
		description: 'Un producto nuevo para un cliente con contrato: el MRR agregado cuenta como Expansión',
	},
	downsell: {
		mrr_effect: 'contraction',
		mrr_effect_label: 'Contracción',
		description: 'Menos cantidad, precio o productos: la baja de MRR cuenta como Contracción (sin llegar a cero)',
	},
	renewal: {
		mrr_effect: 'depends',
		mrr_effect_label: 'Según el precio',
		description: 'Renueva el plazo: sin cambio de precio no mueve el MRR; si sube es Expansión y si baja, Contracción',
	},
	renegotiation: {
		mrr_effect: 'depends',
		mrr_effect_label: 'Según el precio',
		description: 'Cambia condiciones del contrato vigente: el MRR sube (Expansión), baja (Contracción) o no se mueve',
	},
	reactivation: {
		mrr_effect: 'reactivation',
		mrr_effect_label: 'Reactivación',
		description: 'Vuelve un cliente que se había dado de baja: su MRR entra como Reactivación',
	},
};

/** Tipos de contacto del sistema (lista fija) y qué hace cada uno (`billing-collections.service.ts`, procesadores de agentes). */
export const CONTACT_TYPES: { value: string; description: string; used_by: string[] }[] = [
	{
		value: 'Principal',
		description: 'Contacto principal del cliente; recibe correos si no hay uno de facturación o cobranza',
		used_by: ['Cobranza (respaldo)'],
	},
	{ value: 'Comercial', description: 'Contacto de ventas y renovaciones', used_by: [] },
	{ value: 'Facturación', description: 'Recibe facturas y recordatorios de cobranza', used_by: ['Cobranza (recordatorios)'] },
	{
		value: 'Cobranza',
		description: 'Recibe recordatorios de pago y los avisos del agente de cobranza',
		used_by: ['Cobranza (recordatorios)', 'Agente de cobranza'],
	},
	{ value: 'Proforma', description: 'Recibe la proforma antes de emitir la factura', used_by: ['Agente de proforma'] },
];

/**
 * Catálogos del Holding 360: vendedores, motivos de baja y datos maestros (solo tipos de ítem y unidades de medida; condiciones de pago
 * salió de Configuración por decisión de Domi 03-10 —sus filas siguen y Contratos las lee igual—; el resto se retira tras el switch). Borrar solo si no se usa; si se usa, desactivar (409 con la sugerencia).
 */
@Injectable()
export class SettingsCatalogsService {
	constructor(private readonly dataSource: DataSource) {}

	// ── Vendedores ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private readonly sellerSelect = `SELECT s.*, (SELECT count(*) FROM quotes q WHERE q.seller_id = s.id) AS in_use FROM sellers s`;

	async listSellers(holdingId: string) {
		const rows = (await this.dataSource.query(`${this.sellerSelect} WHERE s.holding_id = $1 ORDER BY lower(s.name)`, [holdingId])) as Row[];

		return rows.map(sellerDto);
	}

	private async findSeller(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${this.sellerSelect} WHERE s.id = $1 AND s.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Vendedor no encontrado');

		return row;
	}

	/** El correo es único por holding sin distinguir mayúsculas (la tabla no tiene constraint: se valida aquí). */
	private async assertSellerEmailFree(holdingId: string, email: string, excludeId: string | null) {
		const rows = (await this.dataSource.query(
			`SELECT 1 FROM sellers WHERE holding_id = $1 AND lower(email) = lower($2) AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
			[holdingId, email, excludeId]
		)) as Row[];

		if (rows.length) throw new ConflictException('Ya existe un vendedor con ese correo');
	}

	async createSeller(holdingId: string, dto: CreateSellerDto) {
		await this.assertSellerEmailFree(holdingId, dto.email, null);
		const [row] = (await this.dataSource.query(
			`INSERT INTO sellers (holding_id, name, email, phone, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
			[holdingId, dto.name, dto.email, dto.phone ?? null]
		)) as Row[];

		return sellerDto(await this.findSeller(holdingId, String(row.id)));
	}

	async updateSeller(holdingId: string, id: string, dto: UpdateSellerDto) {
		const current = await this.findSeller(holdingId, id);

		if (dto.email !== undefined) await this.assertSellerEmailFree(holdingId, dto.email, id);
		await this.dataSource.query(`UPDATE sellers SET name = $3, email = $4, phone = $5, is_active = $6 WHERE id = $1 AND holding_id = $2`, [
			id,
			holdingId,
			dto.name ?? current.name,
			dto.email ?? current.email,
			dto.phone === undefined ? (current.phone ?? null) : dto.phone,
			dto.is_active ?? current.is_active,
		]);

		return sellerDto(await this.findSeller(holdingId, id));
	}

	async deleteSeller(holdingId: string, id: string): Promise<void> {
		const seller = await this.findSeller(holdingId, id);
		const inUse = toCount(seller.in_use);

		if (inUse > 0) {
			throw new ConflictException(`Este vendedor está en ${plural(inUse, 'cotización', 'cotizaciones')}: desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM sellers WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	/**
	 * Fusiona vendedores duplicados (Integraciones v2, D7; p. ej. los `sf_<id>@salesforce.local` que crea el CRM): reasigna al destino
	 * todas las referencias de los origen —hoy la única FK a `sellers` es `quotes.seller_id` (verificado en `pg_constraint` de QA, 03-10)—,
	 * copia `crm_owner_id` si el destino no tiene y hay uno solo entre los origen, y borra los origen. Una transacción con `sapira.writer`.
	 */
	async mergeSellers(holdingId: string, dto: MergeSellersDto) {
		const sourceIds = [...new Set(dto.source_ids)];

		if (sourceIds.includes(dto.target_id)) throw new BadRequestException('El vendedor destino no puede estar entre los que se fusionan');
		const sellers = (await this.dataSource.query(`SELECT id, crm_owner_id FROM sellers WHERE holding_id = $1 AND id = ANY($2::uuid[])`, [
			holdingId,
			[dto.target_id, ...sourceIds],
		])) as Row[];
		const target = sellers.find((seller) => seller.id === dto.target_id);

		if (!target || sellers.length !== sourceIds.length + 1) throw new NotFoundException('Vendedor no encontrado');
		const sourceOwners = [
			...new Set(
				sellers
					.filter((seller) => seller.id !== dto.target_id)
					.map((seller) => seller.crm_owner_id)
					.filter(Boolean)
			),
		] as string[];
		const targetOwner = (target.crm_owner_id as string | null) ?? null;

		if (sourceOwners.length > 1 || (targetOwner && sourceOwners.some((owner) => owner !== targetOwner))) {
			throw new ConflictException({
				message: 'Los vendedores tienen dueños distintos del CRM',
				errors: [{ field: 'source_ids', message: 'Quita la relación con el CRM de los que sobran antes de fusionar' }],
			});
		}
		const reassigned = await withApiWriter(this.dataSource, async (runner) => {
			const quotes = (await runner.query(
				`UPDATE quotes SET seller_id = $1 WHERE seller_id = ANY($2::uuid[]) AND holding_id = $3 RETURNING id`,
				[dto.target_id, sourceIds, holdingId]
			)) as unknown[];

			await runner.query(`DELETE FROM sellers WHERE holding_id = $1 AND id = ANY($2::uuid[])`, [holdingId, sourceIds]);
			if (!targetOwner && sourceOwners.length === 1) {
				await runner.query(`UPDATE sellers SET crm_owner_id = $3 WHERE id = $1 AND holding_id = $2`, [
					dto.target_id,
					holdingId,
					sourceOwners[0],
				]);
			}

			return Array.isArray(quotes[0]) ? (quotes[0] as unknown[]).length : quotes.length;
		});

		return { seller: sellerDto(await this.findSeller(holdingId, dto.target_id)), merged: sourceIds.length, reassigned: { quotes: reassigned } };
	}

	// ── Motivos de baja ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	private readonly churnSelect = `SELECT r.*, (SELECT count(*) FROM contracts c WHERE c.churn_reason_id = r.id) AS in_use FROM churn_reasons r`;

	async listChurnReasons(holdingId: string) {
		const rows = (await this.dataSource.query(`${this.churnSelect} WHERE r.holding_id = $1 ORDER BY lower(r.name)`, [holdingId])) as Row[];

		return rows.map(churnReasonDto);
	}

	private async findChurnReason(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${this.churnSelect} WHERE r.id = $1 AND r.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Motivo de baja no encontrado');

		return row;
	}

	async createChurnReason(holdingId: string, dto: CreateNamedDto) {
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(`INSERT INTO churn_reasons (holding_id, name, is_active) VALUES ($1, $2, true) RETURNING id`, [
					holdingId,
					dto.name,
				])) as Row[],
			'Ya existe un motivo de baja con ese nombre'
		);

		return churnReasonDto(await this.findChurnReason(holdingId, String(row.id)));
	}

	async updateChurnReason(holdingId: string, id: string, dto: UpdateNamedDto) {
		const current = await this.findChurnReason(holdingId, id);

		await withUniqueMessage(
			() =>
				this.dataSource.query(`UPDATE churn_reasons SET name = $3, is_active = $4, updated_at = now() WHERE id = $1 AND holding_id = $2`, [
					id,
					holdingId,
					dto.name ?? current.name,
					dto.is_active ?? current.is_active,
				]),
			'Ya existe un motivo de baja con ese nombre'
		);

		return churnReasonDto(await this.findChurnReason(holdingId, id));
	}

	async deleteChurnReason(holdingId: string, id: string): Promise<void> {
		const reason = await this.findChurnReason(holdingId, id);
		const inUse = toCount(reason.in_use);

		if (inUse > 0) {
			throw new ConflictException(`Este motivo está en ${plural(inUse, 'contrato', 'contratos')}: desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM churn_reasons WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	// ── Datos maestros ──────────────────────────────────────────────────────────────────────────────────────────────────────────

	assertCategory(category: string): MasterDataCategory {
		if (!(MASTER_DATA_CATEGORIES as readonly string[]).includes(category)) {
			throw new BadRequestException('Lista no válida: tipos de ítem, unidades de medida, mercados, segmentos o industrias');
		}

		return category as MasterDataCategory;
	}

	private async usageByValue(holdingId: string, category: MasterDataCategory, values: string[]): Promise<Map<string, MasterDataUsage>> {
		const usage = new Map<string, MasterDataUsage>();

		if (!values.length) return usage;
		const results = await Promise.all(
			MASTER_DATA_USAGE[category].map(async (source) => ({
				key: source.key,
				rows: (await this.dataSource.query(source.sql, [holdingId, values])) as Row[],
			}))
		);

		for (const { key, rows } of results) {
			for (const row of rows) {
				const value = String(row.value);
				const entry = usage.get(value) ?? emptyUsage();

				entry[key] += toCount(row.n);
				usage.set(value, entry);
			}
		}

		return usage;
	}

	private masterDataDto(row: Row, usage: Map<string, MasterDataUsage>) {
		const detail = usage.get(String(row.value)) ?? emptyUsage();

		return {
			id: String(row.id),
			category: String(row.category),
			value: String(row.value),
			is_active: row.is_active === true,
			created_at: row.created_at,
			updated_at: row.updated_at,
			in_use: totalUsage(detail),
			usage: detail,
		};
	}

	async listMasterData(holdingId: string, rawCategory: string) {
		const category = this.assertCategory(rawCategory);
		const rows = (await this.dataSource.query(`SELECT * FROM master_data WHERE holding_id = $1 AND category = $2 ORDER BY lower(value)`, [
			holdingId,
			category,
		])) as Row[];
		const usage = await this.usageByValue(
			holdingId,
			category,
			rows.map((row) => String(row.value))
		);

		return rows.map((row) => this.masterDataDto(row, usage));
	}

	private async findMasterData(holdingId: string, category: MasterDataCategory, id: string) {
		const [row] = (await this.dataSource.query(`SELECT * FROM master_data WHERE id = $1 AND holding_id = $2 AND category = $3`, [
			id,
			holdingId,
			category,
		])) as Row[];

		if (!row) throw new NotFoundException('Valor no encontrado');

		return { row, usage: await this.usageByValue(holdingId, category, [String(row.value)]) };
	}

	async createMasterData(holdingId: string, rawCategory: string, dto: CreateMasterDataDto) {
		const category = this.assertCategory(rawCategory);
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`INSERT INTO master_data (holding_id, category, value, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
					[holdingId, category, dto.value]
				)) as Row[],
			'Ya existe ese valor en esta lista'
		);
		const found = await this.findMasterData(holdingId, category, String(row.id));

		return this.masterDataDto(found.row, found.usage);
	}

	async updateMasterData(holdingId: string, rawCategory: string, id: string, dto: UpdateMasterDataDto) {
		const category = this.assertCategory(rawCategory);
		const { row, usage } = await this.findMasterData(holdingId, category, id);
		const inUse = totalUsage(usage.get(String(row.value)));

		if (dto.value !== undefined && dto.value !== row.value && inUse > 0) {
			throw new ConflictException(
				`Este valor está en uso (${plural(inUse, 'registro', 'registros')}): no se puede renombrar; desactívalo y crea uno nuevo`
			);
		}
		await withUniqueMessage(
			() =>
				this.dataSource.query(`UPDATE master_data SET value = $3, is_active = $4, updated_at = now() WHERE id = $1 AND holding_id = $2`, [
					id,
					holdingId,
					dto.value ?? row.value,
					dto.is_active ?? row.is_active,
				]),
			'Ya existe ese valor en esta lista'
		);
		const found = await this.findMasterData(holdingId, category, id);

		return this.masterDataDto(found.row, found.usage);
	}

	async deleteMasterData(holdingId: string, rawCategory: string, id: string): Promise<void> {
		const category = this.assertCategory(rawCategory);
		const { row, usage } = await this.findMasterData(holdingId, category, id);
		const inUse = totalUsage(usage.get(String(row.value)));

		if (inUse > 0) {
			throw new ConflictException(`Este valor está en uso (${plural(inUse, 'registro', 'registros')}): desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM master_data WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	// ── Tipos de negocio y de contacto (solo lectura, ronda 3) ─────────────────────────────────────────────────────────────────────

	/** Los 7 tipos de negocio del sistema con su efecto guía en el MRR y los tipos de oportunidad de Salesforce mapeados del holding. */
	async listBusinessTypes(holdingId: string) {
		const mappings = (await this.dataSource.query(
			`SELECT salesforce_type, sapira_quote_type FROM salesforce_quote_type_mappings
			WHERE holding_id = $1 AND COALESCE(is_active, true) ORDER BY salesforce_type`,
			[holdingId]
		)) as Row[];

		return QUOTE_TYPE_CODES.map((code) => ({
			code,
			label: QUOTE_TYPE_LABELS[code],
			...BUSINESS_TYPE_EFFECTS[code],
			salesforce_types: [
				...new Set(
					mappings
						.filter((row) => normalizeQuoteType(row.sapira_quote_type as string | null) === code)
						.map((row) => String(row.salesforce_type))
				),
			],
		}));
	}

	/** Tipos de contacto fijos con qué hace cada uno y cuántos contactos del holding lo tienen (texto exacto). */
	async listContactTypes(holdingId: string) {
		const rows = (await this.dataSource.query(
			`SELECT contact_type AS value, count(*) AS n FROM client_contacts WHERE holding_id = $1 AND contact_type = ANY($2::text[]) GROUP BY 1`,
			[holdingId, CONTACT_TYPES.map((type) => type.value)]
		)) as Row[];
		const counts = new Map(rows.map((row) => [String(row.value), toCount(row.n)]));

		return CONTACT_TYPES.map((type) => ({
			value: type.value,
			label: type.value,
			description: type.description,
			used_by: type.used_by,
			in_use: counts.get(type.value) ?? 0,
		}));
	}
}
