import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { CONTRACT_DOCUMENT_TYPES, type ContractDocumentType } from '@/databases/postgresql/entities/contratos/contract.entity';

import {
	type BillingEngineInput,
	type BillingEngineItem,
	defaultAnchorDay,
	discountPct,
	generateInvoices,
	itemEndDate,
	itemPricing,
	normalizeTaxRate,
	round2,
	suggestDocumentType,
} from './billing-engine';
import { ContractsService } from './contracts.service';
import {
	type CreateContractDto,
	type CreateContractItemDto,
	type FxRatePeriodDto,
	UF_CURRENCY,
	UF_NOT_INVOICEABLE_MESSAGE,
} from './dtos/create-contract.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

/** Estado inicial de un contrato v2: "En revisión" (la UI v2 lo muestra como "Borrador"). */
export const DRAFT_STATUS = 'En revisión';
/** Etapa a la que pasa la cotización al crear el contrato (mismo nombre que usa el front viejo). */
export const QUOTE_CONTRACT_CREATED_STAGE = 'Contrato creado';
/** Prefijo cuando la compañía no tiene `contract_prefix`. */
export const DEFAULT_CONTRACT_PREFIX = 'CTR';

export const DOCUMENT_TYPE_OPTIONS: Array<{ value: ContractDocumentType; label: string }> = [
	{ value: 'FACTURA', label: 'Factura' },
	{ value: 'FACTURA_EXPORTACION', label: 'Factura de exportación' },
];

/** Condiciones de pago por defecto cuando el holding no las tiene en master data (`payment_terms`). */
export const DEFAULT_PAYMENT_TERMS_PRESETS: Array<PaymentTerms & { label: string }> = [
	{ label: 'Contado', kind: 'net', days: 0 },
	{ label: '30 días', kind: 'net', days: 30 },
	{ label: '45 días', kind: 'net', days: 45 },
	{ label: '60 días', kind: 'net', days: 60 },
	{ label: 'Fin de mes', kind: 'end_of_month', days: 0 },
];

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toIsoDate = (value: unknown) => {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);

	return String(value).slice(0, 10);
};
const todayIso = (now = new Date()) => {
	// Fecha local de la API (TZ America/Santiago en main.ts), no UTC.
	const offset = now.getTimezoneOffset() * 60_000;

	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** 409 cuando falta `contracts.deleted_at` (migración `1790358766159-AddContractBillingFields` sin aplicar). */
export const MISSING_SOFT_DELETE_MESSAGE = 'Falta aplicar la migración de borrado lógico: todavía no se pueden eliminar borradores';

/** `users.id` del usuario autenticado (`contract_lifecycle_events.created_by` es NOT NULL). 403 si no está en Sapira. */
export async function resolveUserId(db: Queryable, authId: string): Promise<string> {
	const [row] = authId ? ((await db.query(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [authId])) as Row[]) : [];

	if (!row) throw new ForbiddenException('Tu usuario no está registrado en Sapira');

	return String(row.id);
}

/**
 * Por qué un contrato no se puede eliminar (S2-9), o null si se puede: solo borradores ("En revisión") sin facturas no
 * legacy. Misma regla para el borrado de uno y el masivo.
 */
export function deleteBlocker(contract: { contract_number?: unknown; status?: unknown; invoices_count?: unknown }): string | null {
	if (contract.status !== DRAFT_STATUS) {
		return `Solo se puede eliminar un contrato en borrador; ${toText(contract.contract_number)} está ${toText(contract.status)}`;
	}
	if (toNumber(contract.invoices_count) > 0) return `No se puede eliminar ${toText(contract.contract_number)}: ya tiene facturas`;

	return null;
}

/**
 * Condición de pago desde un texto de master data o de la cotización ("30 días", "Contado", "Fin de mes", "45"). Devuelve
 * null si no se reconoce (se muestra como advertencia; la usuaria elige).
 */
export function parsePaymentTermsText(text: unknown): PaymentTerms | null {
	const clean = String(text ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase();

	if (!clean) return null;
	if (/^(contado|al contado|inmediato|0)$/.test(clean)) return { kind: 'net', days: 0 };
	const endOfMonth = /fin de mes(?:\s*\+?\s*(\d{1,3}))?/.exec(clean);

	if (endOfMonth) return { kind: 'end_of_month', days: Math.min(365, Number(endOfMonth[1] ?? 0)) };
	const days = /^(?:neto\s*|net\s*)?(\d{1,3})(?:\s*(?:dias|d))?$/.exec(clean);

	if (days) return { kind: 'net', days: Math.min(365, Number(days[1])) };

	return null;
}

/** Solo las claves de la forma (el CHECK valida la clave que corresponde; las demás se descartan). */
export function cleanPaymentTerms(terms: unknown): PaymentTerms | null {
	if (!terms || typeof terms !== 'object') return null;
	const value = terms as Record<string, unknown>;

	if ((value.kind === 'net' || value.kind === 'end_of_month') && Number.isInteger(value.days))
		return { kind: value.kind, days: Number(value.days) };
	if (value.kind === 'day_of_next_month' && Number.isInteger(value.day)) return { kind: 'day_of_next_month', day: Number(value.day) };

	return null;
}

/** Prefijo normalizado: sin guiones al final (`CTR-CO-` y `CTR-CO` dan `CTR-CO-2026-001`). */
export const contractPrefix = (prefix: unknown) =>
	String(prefix ?? '')
		.trim()
		.replace(/-+$/, '') || DEFAULT_CONTRACT_PREFIX;

/**
 * Correlativos válidos: 1 a 5 dígitos. Los números viejos `PREFIJO-AÑO-XXXXXX` (6 hex del UUID, `client.ts` del front
 * viejo) pueden salir solo con dígitos y no deben saltar el correlativo a cientos de miles.
 */
export const correlativePattern = (prefix: string, year: number) => `^${escapeRegex(prefix)}-${year}-(\\d{1,5})$`;

export const formatContractNumber = (prefix: string, year: number, correlative: number) =>
	`${prefix}-${year}-${String(correlative).padStart(3, '0')}`;

interface CompanyRow {
	id: string;
	legal_name: string | null;
	country: string | null;
	currency: string | null;
	contract_prefix: string | null;
	tax_rate: number | null;
	/** `companies.fx_company_policy` (con `to_jsonb`, default `monthly_avg` antes de la migración). */
	fx_company_policy: string;
}

/** Tasa fija lista para `contract_fx_period_rates` (regla "1 [from] = rate [to]", from = moneda del contrato). */
export interface FxRateRow {
	purpose: 'company' | 'invoice';
	from_currency: string;
	to_currency: string;
	rate: number;
	period_start: string;
	period_end: string;
}

/** Política y tasas de tipo de cambio que el borrador guarda (C1, modelo FX v2). */
export interface ResolvedFx {
	invoice_currency: string;
	fx_invoice_policy: 'spot' | 'fixed';
	/** Moneda de facturación ≠ contrato: la política se confirma al crear (`fx_invoice_confirmed_at = now()`). */
	fx_invoice_confirmed: boolean;
	fx_company_policy: string;
	/** Moneda del contrato ≠ compañía: la política se confirma al crear (`fx_company_confirmed_at = now()`). */
	fx_company_confirmed: boolean;
	invoice_rates: FxRateRow[];
	company_rates: FxRateRow[];
}

interface DraftContext {
	company: CompanyRow;
	entity: { id: string; legal_name: string | null; country: string | null; payment_terms: PaymentTerms | null };
	client: { id: string; name: string | null };
	products: Map<string, string>;
}

/** Ítem ya resuelto: precios, fechas y nombre, listo para el motor y para el INSERT. */
interface ResolvedItem {
	key: string;
	dto: CreateContractItemDto;
	product_name: string;
	unit_price: number;
	is_recurring: boolean;
	price: number;
	discount_pct: number;
	final_price: number;
	end_date: string;
}

/**
 * Contratos v2 — creación de borradores (C1), vista previa del generador (§3) y borrado lógico (C5)
 * (`docs/v2-rediseno/mapa-v2-contratos.md`). Todo acotado al holding del guard.
 */
@Injectable()
export class ContractDraftsService {
	private readonly logger = new Logger(ContractDraftsService.name);
	/** Se consulta una vez: cuando la columna existe, ya no deja de existir. */
	private softDeleteReady = false;

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService
	) {}

	// ---------------------------------------------------------------- opciones del formulario

	async formOptions(holdingId: string, now = new Date()) {
		const year = Number(todayIso(now).slice(0, 4));
		const [companies, currencies, masterData, usedTypes, usedUnits, products] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT id, legal_name, holding_name, country, currency, contract_prefix, tax_rate,
					COALESCE(to_jsonb(companies)->>'fx_company_policy', 'monthly_avg') AS fx_company_policy
				FROM companies WHERE holding_id = $1 ORDER BY COALESCE(legal_name, holding_name)`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(`SELECT code FROM currencies WHERE is_active = true ORDER BY code`),
			this.dataSource.query<Row[]>(
				`SELECT category, value FROM master_data
				WHERE holding_id = $1 AND is_active = true AND category IN ('item_types', 'units_of_measure', 'payment_terms')
				ORDER BY category, value`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT ci.item_type AS value FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
				WHERE c.holding_id = $1 AND ci.item_type IS NOT NULL ORDER BY 1`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT ci.unit_of_measure AS value FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
				WHERE c.holding_id = $1 AND ci.unit_of_measure IS NOT NULL ORDER BY 1`,
				[holdingId]
			),
			// Catálogo completo (`products` no tiene flag de activo). Tipo y unidad sugeridos = los más usados del producto
			// en los contratos del holding (el catálogo no los guarda).
			this.dataSource.query<Row[]>(
				`SELECT p.id, p.name, p.product_code, p.is_recurring, p.default_currency, p.default_price, used.item_type, used.unit_of_measure
				FROM products p
				LEFT JOIN LATERAL (
					SELECT mode() WITHIN GROUP (ORDER BY ci.item_type) AS item_type,
						mode() WITHIN GROUP (ORDER BY ci.unit_of_measure) AS unit_of_measure
					FROM contract_items ci WHERE ci.product_id = p.id AND ci.holding_id = $1
				) used ON true
				WHERE p.holding_id = $1
				ORDER BY p.name`,
				[holdingId]
			),
		]);
		const byCategory = (category: string) => masterData.filter((row) => row.category === category).map((row) => String(row.value));
		const itemTypes = byCategory('item_types');
		const units = byCategory('units_of_measure');
		const presets = byCategory('payment_terms')
			.map((label) => {
				const terms = parsePaymentTermsText(label);

				return terms ? { label, ...terms } : null;
			})
			.filter((preset): preset is PaymentTerms & { label: string } => preset !== null);
		const prefixes = [...new Set(companies.map((row) => contractPrefix(row.contract_prefix)))];
		const nextByPrefix = new Map(
			await Promise.all(prefixes.map(async (prefix) => [prefix, await this.nextCorrelative(this.dataSource, holdingId, prefix, year)] as const))
		);

		return {
			companies: companies.map((row) => {
				const prefix = contractPrefix(row.contract_prefix);

				return {
					id: String(row.id),
					legal_name: toText(row.legal_name) ?? toText(row.holding_name),
					country: toText(row.country),
					currency: toText(row.currency),
					contract_prefix: toText(row.contract_prefix),
					tax_rate: normalizeTaxRate(row.tax_rate as number | null),
					/** Política por defecto para devengar en su moneda (`company_default` del contrato la copia). */
					fx_company_policy: toText(row.fx_company_policy) ?? 'monthly_avg',
					next_number: formatContractNumber(prefix, year, nextByPrefix.get(prefix) ?? 1),
				};
			}),
			currencies: currencies.length
				? currencies.map((row) => String(row.code))
				: [...new Set(companies.map((row) => toText(row.currency)).filter((code): code is string => Boolean(code)))].sort(),
			item_types: itemTypes.length ? itemTypes : usedTypes.map((row) => String(row.value)),
			units: units.length ? units : usedUnits.map((row) => String(row.value)),
			payment_terms_presets: presets.length ? presets : DEFAULT_PAYMENT_TERMS_PRESETS,
			document_types: DOCUMENT_TYPE_OPTIONS,
			products: products.map((row) => ({
				id: String(row.id),
				name: toText(row.name),
				product_code: toText(row.product_code),
				item_type: toText(row.item_type),
				unit_of_measure: toText(row.unit_of_measure),
				is_recurring: row.is_recurring === null || row.is_recurring === undefined ? null : Boolean(row.is_recurring),
				default_currency: toText(row.default_currency),
				default_price: row.default_price === null || row.default_price === undefined ? null : toNumber(row.default_price),
			})),
		};
	}

	/** Próximo correlativo de `{prefijo}-{año}-NNN` en el holding (MAX + 1). */
	private async nextCorrelative(db: Queryable, holdingId: string, prefix: string, year: number): Promise<number> {
		const [row] = await db.query(
			`SELECT COALESCE(MAX((substring(contract_number FROM $2))::int), 0) + 1 AS next
			FROM contracts WHERE holding_id = $1 AND contract_number ~ $2`,
			[holdingId, correlativePattern(prefix, year)]
		);

		return toNumber((row as Row | undefined)?.next) || 1;
	}

	// ---------------------------------------------------------------- desde cotización

	async fromQuote(quoteId: string, holdingId: string) {
		const [quote] = await this.dataSource.query<Row[]>(
			`SELECT q.id, q.quote_number, q.quote_type, q.booking_date, q.currency, q.payment_terms, q.salesforce_opportunity_id,
				q.client_id, cl.name_commercial AS client_name, qs.name AS stage_name
			FROM quotes q
			LEFT JOIN clients cl ON cl.id = q.client_id AND cl.holding_id = q.holding_id
			LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
			WHERE q.id = $1 AND q.holding_id = $2`,
			[quoteId, holdingId]
		);

		if (!quote) throw new NotFoundException('Cotización no encontrada');
		await this.assertQuoteUnused(this.dataSource, quoteId, holdingId);

		const clientId = toText(quote.client_id);
		const [entities, items] = await Promise.all([
			clientId
				? this.dataSource.query<Row[]>(
						`SELECT ce.id, ce.legal_name, ce.country, ce.payment_terms
						FROM client_entities ce
						WHERE ce.holding_id = $2
							AND (ce.client_id = $1 OR EXISTS (
								SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1 AND x.holding_id = $2))
						ORDER BY ce.legal_name`,
						[clientId, holdingId]
					)
				: Promise.resolve([] as Row[]),
			this.dataSource.query<Row[]>(
				`SELECT qi.id, qi.product_id, qi.product_name, qi.account, qi.item_type, qi.unit_of_measure, qi.quantity, qi.unit_price,
					qi.annual_unit_price, qi.price_entry_mode, qi.discount_type, qi.discount_value, qi.price, qi.billing_frequency,
					qi.billing_method, qi.start_date, qi.term_months, qi.is_recurring, qi.auto_renew, qi.auto_renew_term_months
				FROM quote_items qi
				WHERE qi.quote_id = $1 AND qi.holding_id = $2
				ORDER BY qi.product_name, qi.id`,
				[quoteId, holdingId]
			),
		]);
		const warnings: string[] = [];
		const paymentTerms = parsePaymentTermsText(quote.payment_terms);

		if (quote.payment_terms && !paymentTerms) {
			warnings.push(
				`La cotización trae la condición de pago "${String(quote.payment_terms)}", que no se pudo interpretar: elígela en el contrato`
			);
		}
		if (quote.stage_name && String(quote.stage_name).trim().toLowerCase() !== 'firmada') {
			warnings.push(`La cotización está en la etapa "${String(quote.stage_name)}", no Firmada`);
		}
		if (!clientId) warnings.push('La cotización no tiene cliente comercial: elígelo en el contrato');
		if (clientId && entities.length === 0) warnings.push('El cliente no tiene razones sociales: crea una antes de guardar el contrato');

		const mappedItems = items.map((row) => {
			const quantity = toNumber(row.quantity) || 1;
			const term = toNumber(row.term_months) || 12;
			const annual = row.price_entry_mode === 'annual';
			const unitPrice =
				row.unit_price !== null && row.unit_price !== undefined ? toNumber(row.unit_price) : round2(toNumber(row.price) / (quantity * term));
			let discount = toNumber(row.discount_value);

			if (discount > 0 && row.discount_type === 'Monto fijo') {
				discount = round2(discountPct({ discount_value: discount, discount_type: 'Monto fijo' }, unitPrice * quantity * term) * 100) / 100;
				warnings.push(`"${String(row.product_name)}": el descuento en monto fijo se convirtió a ${discount} %`);
			}
			if (!row.product_id) warnings.push(`"${String(row.product_name)}" no tiene producto del catálogo: elígelo antes de guardar`);
			if (!row.item_type) warnings.push(`"${String(row.product_name)}" no tiene tipo de ítem: elígelo antes de guardar`);
			if (!row.start_date) warnings.push(`"${String(row.product_name)}" no tiene fecha de inicio: elígela antes de guardar`);

			return {
				key: String(row.id),
				quote_item_id: String(row.id),
				product_id: toText(row.product_id) ?? undefined,
				product_name: toText(row.product_name) ?? undefined,
				account: toText(row.account) ?? undefined,
				item_type: toText(row.item_type) ?? undefined,
				unit_of_measure: toText(row.unit_of_measure) ?? undefined,
				quantity,
				unit_price: unitPrice,
				...(annual && row.annual_unit_price !== null
					? { annual_unit_price: toNumber(row.annual_unit_price), price_entry_mode: 'annual' as const }
					: {}),
				discount_value: discount,
				billing_frequency: toText(row.billing_frequency) ?? 'Mensual',
				billing_method: toText(row.billing_method) ?? 'Anticipado',
				start_date: toIsoDate(row.start_date) ?? undefined,
				term_months: term,
				is_recurring: row.is_recurring !== false,
				// S1-5: se propone lo de la cotización; lo que la usuaria desmarque se respeta al crear.
				auto_renew: row.auto_renew === true,
				...(row.auto_renew_term_months ? { auto_renew_term_months: toNumber(row.auto_renew_term_months) } : {}),
				...(quote.booking_date ? { booking_date: toIsoDate(quote.booking_date)! } : {}),
			};
		});
		const entityList = entities.map((row) => ({
			id: String(row.id),
			legal_name: toText(row.legal_name),
			country: toText(row.country),
			payment_terms: cleanPaymentTerms(row.payment_terms),
		}));

		return {
			quote: {
				id: String(quote.id),
				quote_number: toText(quote.quote_number),
				quote_type: toText(quote.quote_type),
				booking_date: toIsoDate(quote.booking_date),
				currency: toText(quote.currency),
				payment_terms: toText(quote.payment_terms),
				payment_terms_parsed: paymentTerms,
				salesforce_opportunity_id: toText(quote.salesforce_opportunity_id),
			},
			client: { id: clientId, name: toText(quote.client_name) },
			// S1: la razón social se elige siempre. `entity` solo viene si el cliente tiene exactamente una.
			entity: entityList.length === 1 ? entityList[0] : null,
			entities: entityList,
			items: mappedItems,
			warnings,
		};
	}

	/** 409 si la cotización ya generó un contrato vigente (no borrado). */
	private async assertQuoteUnused(db: Queryable, quoteId: string, holdingId: string) {
		const [used] = await db.query(
			`SELECT c.contract_number FROM contracts c WHERE c.quote_id = $1 AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL ORDER BY c.created_at LIMIT 1`,
			[quoteId, holdingId]
		);

		if (used) {
			throw new ConflictException(`La cotización ya tiene un contrato creado (${toText((used as Row).contract_number) ?? 'sin número'})`);
		}
	}

	// ---------------------------------------------------------------- contexto compartido (preview y create)

	/** Carga compañía, razón social, cliente y productos del holding; junta los errores por campo (400). */
	private async loadContext(db: Queryable, dto: CreateContractDto, holdingId: string): Promise<DraftContext> {
		const productIds = [...new Set(dto.items.map((item) => item.product_id))];
		const [[company], [entity], [client], products, currencies] = await Promise.all([
			db.query(
				`SELECT id, legal_name, country, currency, contract_prefix, tax_rate,
					COALESCE(to_jsonb(companies)->>'fx_company_policy', 'monthly_avg') AS fx_company_policy
				FROM companies WHERE id = $1 AND holding_id = $2`,
				[dto.company_id, holdingId]
			) as Promise<Row[]>,
			db.query(
				`SELECT ce.id, ce.legal_name, ce.country, ce.payment_terms,
					(ce.client_id = $3 OR EXISTS (
						SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $3 AND x.holding_id = $2)) AS belongs
				FROM client_entities ce WHERE ce.id = $1 AND ce.holding_id = $2`,
				[dto.client_entity_id, holdingId, dto.client_id]
			) as Promise<Row[]>,
			db.query(`SELECT id, name_commercial FROM clients WHERE id = $1 AND holding_id = $2`, [dto.client_id, holdingId]) as Promise<Row[]>,
			db.query(`SELECT id, name FROM products WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [productIds, holdingId]) as Promise<Row[]>,
			db.query(`SELECT code FROM currencies WHERE is_active = true`) as Promise<Row[]>,
		]);
		const errors: FieldError[] = [];

		if (!client) errors.push({ field: 'client_id', message: 'El cliente no existe en el holding' });
		if (!entity) errors.push({ field: 'client_entity_id', message: 'La razón social no existe en el holding' });
		else if (client && entity.belongs !== true) errors.push({ field: 'client_entity_id', message: 'La razón social no pertenece al cliente' });
		if (!company) errors.push({ field: 'company_id', message: 'La compañía no existe en el holding' });

		const knownCurrencies = new Set(currencies.map((row) => String(row.code)));

		if (knownCurrencies.size && !knownCurrencies.has(dto.contract_currency)) {
			errors.push({ field: 'contract_currency', message: `La moneda ${dto.contract_currency} no está habilitada` });
		}
		if (knownCurrencies.size && dto.invoice_currency && !knownCurrencies.has(dto.invoice_currency)) {
			errors.push({ field: 'invoice_currency', message: `La moneda ${dto.invoice_currency} no está habilitada` });
		}

		const productNames = new Map(products.map((row) => [String(row.id), String(row.name ?? '')]));
		const seenKeys = new Set<string>();

		dto.items.forEach((item, index) => {
			if (!productNames.has(item.product_id))
				errors.push({ field: `items.${index}.product_id`, message: 'El producto no existe en el catálogo del holding' });
			if (item.key) {
				if (seenKeys.has(item.key)) errors.push({ field: `items.${index}.key`, message: 'Ítem repetido' });
				seenKeys.add(item.key);
			}
			if (item.price_entry_mode === 'annual' && (item.annual_unit_price === undefined || item.annual_unit_price === null)) {
				errors.push({ field: `items.${index}.annual_unit_price`, message: 'Escribe el precio anual' });
			}
		});

		if (errors.length) throw validationException(errors);

		return {
			company: {
				id: String(company.id),
				legal_name: toText(company.legal_name),
				country: toText(company.country),
				currency: toText(company.currency),
				contract_prefix: toText(company.contract_prefix),
				tax_rate: company.tax_rate === null || company.tax_rate === undefined ? null : Number(company.tax_rate),
				fx_company_policy: toText(company.fx_company_policy) ?? 'monthly_avg',
			},
			entity: {
				id: String(entity.id),
				legal_name: toText(entity.legal_name),
				country: toText(entity.country),
				payment_terms: cleanPaymentTerms(entity.payment_terms),
			},
			client: { id: String(client.id), name: toText(client.name_commercial) },
			products: productNames,
		};
	}

	/** Precios, fin y nombre de cada ítem (unitario mensual; el anual se divide en 12 como `auto_calculate_pricing_fields`). */
	static resolveItems(dto: CreateContractDto, products: Map<string, string>): ResolvedItem[] {
		return dto.items.map((item, index) => {
			const unitPrice = item.price_entry_mode === 'annual' ? Number(item.annual_unit_price ?? 0) / 12 : Number(item.unit_price ?? 0);
			const pricing = itemPricing({
				quantity: item.quantity,
				unit_price: unitPrice,
				term_months: item.term_months,
				discount_value: item.discount_value,
			});

			return {
				key: item.key || `item-${index + 1}`,
				dto: item,
				product_name: item.product_name?.trim() || products.get(item.product_id) || 'Producto',
				unit_price: unitPrice,
				is_recurring: item.is_recurring !== false,
				price: pricing.price,
				discount_pct: pricing.discount_pct,
				final_price: pricing.final_price,
				end_date: itemEndDate(item.start_date, item.term_months),
			};
		});
	}

	/**
	 * Política y tasas de tipo de cambio del borrador (modelo FX v2). Regla única de las tasas: "1 [moneda del contrato] =
	 * rate [otra moneda]", siempre contrato → otra moneda.
	 * - Facturación: con moneda de factura ≠ contrato, `spot` o `fixed`; `fixed` guarda sus tasas con `purpose = 'invoice'`.
	 * - Compañía (S1-17): con moneda del contrato ≠ compañía, `company_default` copia `companies.fx_company_policy`
	 *   (snapshot) y `fixed_period` guarda tasas propias con `purpose = 'company'`. Con la misma moneda se copia igual la
	 *   política de la compañía, sin tasas.
	 * - Una tasa sin fechas cubre el contrato (primer inicio → último fin de los ítems). Fin > inicio y sin solapes.
	 * Errores por campo (400) si se mandan tasas o políticas que no aplican.
	 */
	static resolveFx(dto: CreateContractDto, context: DraftContext, items: ResolvedItem[]): ResolvedFx {
		const contractCurrency = dto.contract_currency.toUpperCase();
		const companyCurrency = context.company.currency?.trim().toUpperCase() || null;
		const errors: FieldError[] = [];
		// La UF no se factura (el DTO rechaza invoice_currency = CLF). Contrato en UF sin moneda de facturación: CLP si la
		// compañía factura en CLP; si no, la usuaria la elige.
		let invoiceCurrency = (dto.invoice_currency ?? '').trim().toUpperCase();

		if (invoiceCurrency === UF_CURRENCY) errors.push({ field: 'invoice_currency', message: UF_NOT_INVOICEABLE_MESSAGE });
		if (!invoiceCurrency) {
			if (contractCurrency !== UF_CURRENCY) invoiceCurrency = contractCurrency;
			else if (companyCurrency === 'CLP') invoiceCurrency = 'CLP';
			else {
				errors.push({
					field: 'invoice_currency',
					message: 'Un contrato en UF se factura en otra moneda: elige la moneda de facturación (por ejemplo, CLP)',
				});
				invoiceCurrency = contractCurrency;
			}
		}
		const invoiceFx = invoiceCurrency !== contractCurrency;
		const companyFx = Boolean(companyCurrency && companyCurrency !== contractCurrency);

		if (!invoiceFx && (dto.fx_invoice_policy === 'fixed' || dto.fx_invoice_rates?.length)) {
			errors.push({ field: 'fx_invoice_policy', message: 'Se factura en la moneda del contrato: no lleva tipo de cambio fijo' });
		} else if (invoiceFx && dto.fx_invoice_policy !== 'fixed' && dto.fx_invoice_rates?.length) {
			errors.push({ field: 'fx_invoice_rates', message: 'Las tasas fijas de facturación solo aplican con tipo de cambio fijo' });
		}
		if (!companyFx && (dto.fx_company_policy === 'fixed_period' || dto.fx_company_rates?.length)) {
			errors.push({ field: 'fx_company_policy', message: 'El contrato está en la moneda de la compañía: no lleva tipo de cambio de compañía' });
		} else if (companyFx && dto.fx_company_policy !== 'fixed_period' && dto.fx_company_rates?.length) {
			errors.push({ field: 'fx_company_rates', message: 'Las tasas fijas de la compañía solo aplican con la política de tasas fijas' });
		}

		const starts = items.map((item) => item.dto.start_date).sort();
		const ends = items.map((item) => item.end_date).sort();
		const coverageStart = starts[0];
		const coverageEnd = ends[ends.length - 1];
		const normalize = (
			rates: FxRatePeriodDto[] | undefined,
			field: 'fx_invoice_rates' | 'fx_company_rates',
			purpose: FxRateRow['purpose'],
			toCurrency: string
		): FxRateRow[] => {
			const rows = (rates ?? []).map((rate, index) => ({
				index,
				row: {
					purpose,
					from_currency: contractCurrency,
					to_currency: toCurrency,
					rate: Number(rate.rate),
					period_start: rate.period_start ?? coverageStart,
					period_end: rate.period_end ?? coverageEnd,
				},
			}));

			rows.forEach(({ index, row }) => {
				if (!(row.period_end > row.period_start)) {
					errors.push({ field: `${field}.${index}.period_end`, message: 'El fin de la tasa debe ser posterior a su inicio' });
				}
			});
			const sorted = [...rows].sort((a, b) => a.row.period_start.localeCompare(b.row.period_start));

			sorted.slice(1).forEach(({ index, row }, position) => {
				const previous = sorted[position].row;

				if (row.period_start <= previous.period_end) {
					errors.push({
						field: `${field}.${index}.period_start`,
						message: `La tasa se superpone con la del ${previous.period_start} al ${previous.period_end}`,
					});
				}
			});

			return rows.map(({ row }) => row);
		};
		const invoiceRates =
			invoiceFx && dto.fx_invoice_policy === 'fixed' ? normalize(dto.fx_invoice_rates, 'fx_invoice_rates', 'invoice', invoiceCurrency) : [];
		const companyRates =
			companyFx && dto.fx_company_policy === 'fixed_period'
				? normalize(dto.fx_company_rates, 'fx_company_rates', 'company', companyCurrency!)
				: [];

		if (errors.length) throw validationException(errors);

		return {
			invoice_currency: invoiceCurrency,
			fx_invoice_policy: invoiceFx ? (dto.fx_invoice_policy ?? 'spot') : 'spot',
			fx_invoice_confirmed: invoiceFx,
			fx_company_policy: companyFx && dto.fx_company_policy === 'fixed_period' ? 'fixed_period' : context.company.fx_company_policy,
			fx_company_confirmed: companyFx,
			invoice_rates: invoiceRates,
			company_rates: companyRates,
		};
	}

	/** Defaults del contrato a partir del DTO y el contexto (mismos en la vista previa y al guardar). */
	static contractDefaults(dto: CreateContractDto, context: DraftContext, items: ResolvedItem[]) {
		const documentType: ContractDocumentType =
			dto.document_type && (CONTRACT_DOCUMENT_TYPES as readonly string[]).includes(dto.document_type)
				? dto.document_type
				: suggestDocumentType(context.company.country, context.entity.country);
		const fx = ContractDraftsService.resolveFx(dto, context, items);

		return {
			fx,
			invoice_currency: fx.invoice_currency,
			fx_invoice_policy: fx.fx_invoice_policy,
			fx_company_policy: fx.fx_company_policy,
			payment_terms: cleanPaymentTerms(dto.payment_terms) ?? context.entity.payment_terms,
			document_type: documentType,
			billing_anchor_day:
				dto.billing_anchor_day ??
				defaultAnchorDay(items.map((item) => ({ start_date: item.dto.start_date, is_recurring: item.is_recurring }))) ??
				1,
			group_invoices_by_period: dto.group_invoices_by_period ?? true,
		};
	}

	static engineInput(dto: CreateContractDto, context: DraftContext, items: ResolvedItem[]): BillingEngineInput {
		const defaults = ContractDraftsService.contractDefaults(dto, context, items);

		return {
			contract: {
				billing_anchor_day: defaults.billing_anchor_day,
				group_invoices_by_period: defaults.group_invoices_by_period,
				invoice_currency: defaults.invoice_currency,
				contract_currency: dto.contract_currency,
				fx_invoice_policy: defaults.fx_invoice_policy,
				// Vista previa con la tasa fija de facturación (misma regla que la activación).
				fixed_invoice_rates: defaults.fx.invoice_rates,
				payment_terms: defaults.payment_terms,
				document_type: defaults.document_type,
				company: { country: context.company.country, tax_rate: context.company.tax_rate },
				entity_country: context.entity.country,
			},
			items: items.map(
				(item): BillingEngineItem => ({
					key: item.key,
					product_id: item.dto.product_id,
					product_name: item.product_name,
					account: item.dto.account ?? null,
					quantity: item.dto.quantity,
					unit_price: item.unit_price,
					discount_value: item.discount_pct,
					billing_frequency: item.dto.billing_frequency,
					billing_method: item.dto.billing_method,
					start_date: item.dto.start_date,
					term_months: item.dto.term_months,
					end_date: item.end_date,
					is_recurring: item.is_recurring,
					final_price: item.final_price,
				})
			),
		};
	}

	// ---------------------------------------------------------------- vista previa

	async preview(dto: CreateContractDto, holdingId: string) {
		const context = await this.loadContext(this.dataSource, dto, holdingId);
		const items = ContractDraftsService.resolveItems(dto, context.products);

		return generateInvoices(ContractDraftsService.engineInput(dto, context, items));
	}

	// ---------------------------------------------------------------- crear (C1)

	/**
	 * Crea el contrato en borrador en **una transacción**: número correlativo con lock por (holding, prefijo, año),
	 * contrato, ítems, auto-renovación respetada (S1-5), cotización a "Contrato creado" y evento `CREATED`.
	 * No escribe `contract_invoices` ni facturas: nacen al activar (decisión 2 del mapa).
	 */
	async create(dto: CreateContractDto, holdingId: string, authId: string, now = new Date()) {
		const userId = await this.userId(authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		let contractId: string;

		try {
			const context = await this.loadContext(runner, dto, holdingId);
			const items = ContractDraftsService.resolveItems(dto, context.products);
			const defaults = ContractDraftsService.contractDefaults(dto, context, items);
			const quote = dto.quote_id ? await this.lockQuote(runner, dto, holdingId) : null;
			const contractNumber = await this.reserveNumber(runner, dto, context, holdingId, now);
			const [settings] = (await runner.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [
				holdingId,
			])) as Row[];
			const systemCurrency = toText(settings?.system_currency) ?? 'USD';
			const totalValue = round2(items.reduce((sum, item) => sum + item.final_price, 0));
			const recurringEnds = items.filter((item) => item.is_recurring).map((item) => item.end_date);
			// Compatibilidad con los consumidores actuales: fin del contrato = el mayor fin de los recurrentes.
			// v2 muestra además el próximo vencimiento por ítem (`next_item_end_date`).
			const contractEnd = recurringEnds.length ? [...recurringEnds].sort().reverse()[0] : null;
			const bookingDate = dto.booking_date ?? toIsoDate(quote?.booking_date) ?? null;

			const [inserted] = (await runner.query(
				`INSERT INTO contracts (
					holding_id, client_id, client_entity_id, company_id, quote_id, contract_number, type, status,
					total_value, legal_client_name, client_name_commercial, notes, current_step_id, workflow_started_at,
					booking_date, contract_end_date, contract_currency, system_currency, fx_rate_to_system, total_value_system_currency,
					company_currency, fx_company_policy, fx_invoice_policy, invoice_currency,
					requires_multicompany_billing, requires_multicurrency_billing, requires_references_for_billing, requires_contract_document,
					custom_fields, auto_invoice, auto_send_to_odoo, group_invoices_by_period, salesforce_opportunity_id,
					invoice_terms_and_conditions, billing_anchor_day, payment_terms, document_type,
					fx_invoice_confirmed_at, fx_company_confirmed_at
				) VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8,
					$9, $10, $11, $12, NULL, NULL,
					$13, $14, $15, $16, $17, $18,
					$19, $20, $21, $22,
					$23, $24, $25, $26,
					$27::jsonb, $28, $29, $30, $31,
					$32, $33, $34::jsonb, $35,
					CASE WHEN $36::boolean THEN now() END, CASE WHEN $37::boolean THEN now() END
				) RETURNING id`,
				[
					holdingId,
					context.client.id,
					context.entity.id,
					context.company.id,
					dto.quote_id ?? null,
					contractNumber,
					toText(quote?.quote_type),
					DRAFT_STATUS,
					totalValue,
					context.entity.legal_name,
					context.client.name,
					dto.notes ?? null,
					bookingDate,
					contractEnd,
					dto.contract_currency,
					systemCurrency,
					systemCurrency === dto.contract_currency ? 1 : null,
					systemCurrency === dto.contract_currency ? totalValue : null,
					context.company.currency,
					defaults.fx_company_policy,
					defaults.fx_invoice_policy,
					defaults.invoice_currency,
					quote?.requires_multicompany === true,
					quote?.requires_multicurrency === true,
					quote?.requires_references_for_billing === true,
					quote?.requires_contract_document === true,
					JSON.stringify(dto.custom_fields ?? {}),
					dto.auto_invoice ?? false,
					// S6-10: apagado por defecto.
					dto.auto_send_to_odoo ?? false,
					defaults.group_invoices_by_period,
					dto.salesforce_opportunity_id ?? toText(quote?.salesforce_opportunity_id),
					dto.invoice_terms_and_conditions ?? null,
					defaults.billing_anchor_day,
					defaults.payment_terms ? JSON.stringify(defaults.payment_terms) : null,
					defaults.document_type,
					defaults.fx.fx_invoice_confirmed,
					defaults.fx.fx_company_confirmed,
				]
			)) as Row[];

			contractId = String(inserted.id);
			const quoteItems = await this.quoteItems(runner, dto, quote);
			const itemIds: string[] = [];

			for (const item of items) {
				const quoteItem = item.dto.quote_item_id ? quoteItems.get(item.dto.quote_item_id) : undefined;
				const [row] = (await runner.query(
					`INSERT INTO contract_items (
						contract_id, holding_id, product_id, product_name, account, item_type, unit_of_measure,
						quantity, unit_price, annual_unit_price, price_entry_mode, discount_type, discount_value,
						price, final_price, currency, billing_frequency, billing_method, start_date, end_date, term_months,
						is_recurring, quote_item_id, quote_item_number, custom_fields, auto_renew, auto_renew_term_months, booking_date
					) VALUES (
						$1, $2, $3, $4, $5, $6, $7,
						$8, $9, $10, $11, $12, $13,
						$14, $15, $16, $17, $18, $19, $20, $21,
						$22, $23, $24, $25::jsonb, $26, $27, $28
					) RETURNING id, auto_renew`,
					[
						contractId,
						holdingId,
						item.dto.product_id,
						item.product_name,
						item.dto.account || null,
						item.dto.item_type,
						item.dto.unit_of_measure || null,
						item.dto.quantity,
						// Modo anual: el trigger `auto_calculate_pricing_fields` deriva el mensual (anual / 12).
						item.dto.price_entry_mode === 'annual' ? null : item.unit_price,
						item.dto.price_entry_mode === 'annual' ? item.dto.annual_unit_price : null,
						item.dto.price_entry_mode ?? 'monthly',
						item.discount_pct > 0 ? 'Porcentaje' : null,
						item.discount_pct,
						item.price,
						item.final_price,
						// S1-2: el ítem hereda la moneda del contrato.
						dto.contract_currency,
						item.dto.billing_frequency,
						item.dto.billing_method,
						item.dto.start_date,
						// `set_contract_item_end_date` recalcula el mismo valor (inicio + término − 1 día).
						item.end_date,
						item.dto.term_months,
						item.is_recurring,
						item.dto.quote_item_id ?? null,
						toText(quoteItem?.quote_item_number),
						JSON.stringify(quoteItem?.custom_fields ?? {}),
						item.dto.auto_renew ?? false,
						item.dto.auto_renew_term_months ?? null,
						item.dto.booking_date ?? bookingDate,
					]
				)) as Row[];

				itemIds.push(String(row.id));
				// S1-5: `inherit_auto_renew_from_quote_item` (BEFORE INSERT) trata `false` como "no especificado" y hereda
				// el valor de la cotización. Se corrige solo esa columna con lo que eligió la usuaria.
				const requested = item.dto.auto_renew ?? false;

				if (Boolean(row.auto_renew) !== requested) {
					await runner.query(`UPDATE contract_items SET auto_renew = $2 WHERE id = $1`, [row.id, requested]);
				}
			}

			// Tasas fijas de facturación y de compañía, con su propósito, en la misma transacción.
			for (const rate of [...defaults.fx.invoice_rates, ...defaults.fx.company_rates]) {
				await runner.query(
					`INSERT INTO contract_fx_period_rates (
						contract_id, holding_id, purpose, from_currency, to_currency, rate, period_start, period_end, notes, created_by
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[
						contractId,
						holdingId,
						rate.purpose,
						rate.from_currency,
						rate.to_currency,
						rate.rate,
						rate.period_start,
						rate.period_end,
						'Cargada al crear el contrato (v2)',
						userId,
					]
				);
			}

			const quoteStageUpdated = quote ? await this.markQuoteContractCreated(runner, String(quote.id), holdingId) : false;

			await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at,
					effective_date, items_affected, metadata
				) VALUES ($1, $2, 'CREATED', 'Completed', $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb)`,
				[
					contractId,
					holdingId,
					'Contrato creado (borrador)',
					quote
						? `Borrador ${contractNumber} creado desde la cotización ${toText(quote.quote_number) ?? ''} con ${items.length} ítem(s)`.replace(
								/\s+/g,
								' '
							)
						: `Borrador ${contractNumber} creado manualmente con ${items.length} ítem(s)`,
					userId,
					todayIso(now),
					JSON.stringify(itemIds),
					JSON.stringify({
						source: 'api_v2',
						quote_id: dto.quote_id ?? null,
						origin: dto.quote_id ? `quote:${dto.quote_id}` : 'manual',
						contract_number: contractNumber,
						total_value: totalValue,
						quote_stage_updated: quote ? quoteStageUpdated : null,
					}),
				]
			);

			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.contracts.detail(contractId, holdingId);
	}

	/** `users.id` del usuario autenticado (`contract_lifecycle_events.created_by` es NOT NULL). */
	private async userId(authId: string): Promise<string> {
		return await resolveUserId(this.dataSource, authId);
	}

	/** 409 legible (no un 500) si la base todavía no tiene `contracts.deleted_at`. */
	private async assertSoftDeleteReady() {
		if (this.softDeleteReady) return;
		const [column] = await this.dataSource.query<Row[]>(
			`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = 'deleted_at'`
		);

		if (!column) throw new ConflictException(MISSING_SOFT_DELETE_MESSAGE);
		this.softDeleteReady = true;
	}

	/** Cotización del holding bloqueada para esta transacción; 409 si ya tiene contrato; valida las líneas. */
	private async lockQuote(runner: QueryRunner, dto: CreateContractDto, holdingId: string): Promise<Row> {
		const [quote] = (await runner.query(
			`SELECT id, quote_number, quote_type, booking_date, salesforce_opportunity_id, requires_multicompany, requires_multicurrency,
				requires_references_for_billing, requires_contract_document
			FROM quotes WHERE id = $1 AND holding_id = $2 FOR UPDATE`,
			[dto.quote_id, holdingId]
		)) as Row[];

		if (!quote) throw validationException([{ field: 'quote_id', message: 'La cotización no existe en el holding' }]);
		await this.assertQuoteUnused(runner, String(dto.quote_id), holdingId);

		return quote;
	}

	private async quoteItems(runner: QueryRunner, dto: CreateContractDto, quote: Row | null): Promise<Map<string, Row>> {
		const ids = dto.items.map((item) => item.quote_item_id).filter((id): id is string => Boolean(id));

		if (!ids.length) return new Map();
		if (!quote) throw validationException([{ field: 'quote_id', message: 'Los ítems de cotización requieren la cotización de origen' }]);
		const rows = (await runner.query(
			`SELECT id, quote_item_number, custom_fields FROM quote_items WHERE id = ANY($1::uuid[]) AND quote_id = $2`,
			[ids, quote.id]
		)) as Row[];
		const found = new Map(rows.map((row) => [String(row.id), row]));
		const errors: FieldError[] = [];

		dto.items.forEach((item, index) => {
			if (item.quote_item_id && !found.has(item.quote_item_id)) {
				errors.push({ field: `items.${index}.quote_item_id`, message: 'La línea no pertenece a la cotización' });
			}
		});
		if (errors.length) throw validationException(errors);

		return found;
	}

	/**
	 * Número del contrato (S1-1). Manual: 409 si ya existe en el holding (también entre borrados, para que el futuro
	 * UNIQUE no choque). Automático: `{prefijo}-{año}-{NNN}` = MAX de los que calzan el patrón + 1, con
	 * `pg_advisory_xact_lock` por (holding, prefijo, año) para que dos creaciones simultáneas no tomen el mismo.
	 */
	private async reserveNumber(runner: QueryRunner, dto: CreateContractDto, context: DraftContext, holdingId: string, now: Date) {
		if (dto.contract_number) {
			await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contracts:${holdingId}:number:${dto.contract_number}`]);
			const [existing] = (await runner.query(`SELECT 1 FROM contracts WHERE holding_id = $1 AND contract_number = $2 LIMIT 1`, [
				holdingId,
				dto.contract_number,
			])) as Row[];

			if (existing) throw new ConflictException(`Ya existe un contrato con el número ${dto.contract_number}`);

			return dto.contract_number;
		}

		const prefix = contractPrefix(context.company.contract_prefix);
		const year = Number(todayIso(now).slice(0, 4));

		await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`contracts:${holdingId}:${prefix}:${year}`]);

		return formatContractNumber(prefix, year, await this.nextCorrelative(runner, holdingId, prefix, year));
	}

	/**
	 * Mueve la cotización a la etapa "Contrato creado" del holding, como `markQuoteAsContractCreated` del front viejo
	 * (que la busca por nombre). Si el holding no tiene esa etapa, la cotización queda donde está (el front viejo hace lo
	 * mismo) y el evento lo registra en `metadata.quote_stage_updated`.
	 */
	private async markQuoteContractCreated(runner: QueryRunner, quoteId: string, holdingId: string): Promise<boolean> {
		const [stage] = (await runner.query(`SELECT id FROM quote_stages WHERE holding_id = $1 AND lower(name) = lower($2) LIMIT 1`, [
			holdingId,
			QUOTE_CONTRACT_CREATED_STAGE,
		])) as Row[];

		if (!stage) {
			this.logger.warn(
				`El holding ${holdingId} no tiene la etapa "${QUOTE_CONTRACT_CREATED_STAGE}": la cotización ${quoteId} queda en su etapa`
			);

			return false;
		}
		await runner.query(`UPDATE quotes SET quote_stage_id = $3 WHERE id = $1 AND holding_id = $2`, [quoteId, holdingId, stage.id]);

		return true;
	}

	// ---------------------------------------------------------------- borrar (C5)

	/**
	 * Borrado lógico de un borrador (S2-9): solo "En revisión" y sin facturas no legacy. Marca `deleted_at` y deja el
	 * evento `DELETED`. No toca ítems ni la cotización.
	 */
	async remove(idOrNumber: string, holdingId: string, authId: string) {
		await this.assertSoftDeleteReady();
		const userId = await this.userId(authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			const key = (idOrNumber ?? '').trim();
			const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
			const [contract] = (await runner.query(
				`SELECT c.id, c.contract_number, c.status,
					(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false) AS invoices_count
				FROM contracts c
				WHERE ${byId ? 'c.id = $1::uuid' : 'c.contract_number = $1'} AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL
				ORDER BY c.created_at DESC LIMIT 1
				FOR UPDATE OF c`,
				[key, holdingId]
			)) as Row[];

			if (!contract) throw new NotFoundException('Contrato no encontrado');
			const blocker = deleteBlocker(contract);

			if (blocker) throw new ConflictException(blocker);

			await this.softDelete(runner, contract, holdingId, userId);
			await runner.commitTransaction();

			return { id: String(contract.id), contract_number: toText(contract.contract_number), deleted: true };
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}

	/** `deleted_at` + evento `DELETED` (borrado de uno y masivo). */
	private async softDelete(runner: QueryRunner, contract: Row, holdingId: string, userId: string, source: 'single' | 'bulk' = 'single') {
		await runner.query(`UPDATE contracts SET deleted_at = now() WHERE id = $1 AND holding_id = $2`, [contract.id, holdingId]);
		await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, 'DELETED', 'Completed', 'Borrador eliminado', $3, $4, now(), CURRENT_DATE, $5::jsonb)`,
			[
				contract.id,
				holdingId,
				`Se eliminó el borrador ${toText(contract.contract_number) ?? ''}`.trim(),
				userId,
				JSON.stringify({ source: 'api_v2', contract_number: toText(contract.contract_number), ...(source === 'bulk' ? { bulk: true } : {}) }),
			]
		);
	}

	/**
	 * Borrado lógico masivo (C5): misma regla que `remove` para cada contrato, en **una transacción**. Se eliminan los que
	 * califican; los demás (no son del holding, no son borrador o tienen facturas) vuelven en `skipped` con el motivo.
	 */
	async bulkRemove(ids: string[], holdingId: string, authId: string) {
		await this.assertSoftDeleteReady();
		const userId = await this.userId(authId);
		const uniqueIds = [...new Set(ids)];
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			const rows = (await runner.query(
				`SELECT c.id, c.contract_number, c.status,
					(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false) AS invoices_count
				FROM contracts c
				WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL
				ORDER BY c.contract_number, c.id
				FOR UPDATE OF c`,
				[uniqueIds, holdingId]
			)) as Row[];
			const byId = new Map(rows.map((row) => [String(row.id), row]));
			const deleted: Array<{ id: string; contract_number: string | null }> = [];
			const skipped: Array<{ id: string; contract_number: string | null; reason: string }> = [];

			for (const id of uniqueIds) {
				const contract = byId.get(id);

				if (!contract) {
					skipped.push({ id, contract_number: null, reason: 'El contrato no existe en el holding o ya fue eliminado' });
					continue;
				}
				const blocker = deleteBlocker(contract);

				if (blocker) {
					skipped.push({ id, contract_number: toText(contract.contract_number), reason: blocker });
					continue;
				}
				await this.softDelete(runner, contract, holdingId, userId, 'bulk');
				deleted.push({ id, contract_number: toText(contract.contract_number) });
			}
			await runner.commitTransaction();

			return { deleted, skipped };
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}
}
