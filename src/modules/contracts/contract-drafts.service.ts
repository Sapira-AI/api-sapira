import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { CONTRACT_DOCUMENT_TYPES, type ContractDocumentType } from '@/databases/postgresql/entities/contratos/contract.entity';

import { setApiWriter } from './api-writer';
import { itemCategoriaSql, pricingFields, syncContractTerm } from './api-written-fields';
import {
	type BillingEngineInput,
	type BillingEngineItem,
	discountPct,
	generateInvoices,
	indefiniteHorizonMonths,
	isIndefiniteItem,
	itemEndDate,
	itemPricing,
	normalizeCountry,
	normalizeTaxRate,
	pricedMonthlyEquivalent,
	round2,
	suggestDocumentType,
} from './billing-engine';
import { type CatalogPrice, catalogPriceErrors, catalogPriceIds, loadCatalogPrices } from './catalog-prices';
import { ContractsService } from './contracts.service';
import {
	type CreateContractDto,
	type CreateContractItemDto,
	type FxRatePeriodDto,
	hasPricingModel,
	type PricePreviewDto,
	UF_CURRENCY,
	UF_NOT_INVOICEABLE_MESSAGE,
	type UpdateContractDto,
	type UpdateContractItemDto,
	type UpdateContractTermsDto,
} from './dtos/create-contract.dto';
import { parseStoredTemplate } from './invoice-description';
import { type CodedFieldError, codedValidationException, MULTICURRENCY_CODES, toContractCurrency, upperCode } from './multicurrency';
import { normalizePriceSpec, PRICE_COLUMNS, priceSpecFromRow, samePriceSpec } from './price-rows';
import {
	type ConsumptionInput,
	DEFAULT_INVOICE_LINE_MODE,
	isMetered,
	type PricedLine,
	priceLine,
	type PriceSpec,
	validatePriceSpec,
} from './pricing-engine';
import {
	catalogForCountry,
	CONTRACT_TAX_DOCUMENT_KINDS,
	DESCRIPTION_LIMITS_SQL,
	descriptionMaxCharsOfRow,
	DOCUMENT_TYPE_LABELS,
	documentTypeFromKind,
	suggestTaxDocumentType,
	TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE,
	type TaxDocumentTypeOption,
} from './tax-document-types';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

/** Estado inicial de un contrato v2: "En revisión" (la UI v2 lo muestra como "Borrador"). */
export const DRAFT_STATUS = 'En revisión';
/** Estado en el que las condiciones de factura ya no se editan. */
export const CONTRACT_CANCELLED_STATUS = 'Cancelado';
/** Etapa a la que pasa la cotización al crear el contrato (mismo nombre que usa el front viejo). */
export const QUOTE_CONTRACT_CREATED_STAGE = 'Contrato creado';
/** Prefijo cuando la compañía no tiene `contract_prefix`. */
export const DEFAULT_CONTRACT_PREFIX = 'CTR';
/** Pricing v2: un ítem por consumo se factura Vencido en etapa 1 (400 si viene Anticipado, salvo `seat`; spec §3.7). */
export const METERED_ADVANCE_MESSAGE = 'Un ítem por consumo se factura Vencido: el consumo se conoce al cerrar el período';

/** Familias de documento (compatibilidad): el formulario v2 elige del catálogo `tax_document_types`. */
export const DOCUMENT_TYPE_OPTIONS: Array<{ value: ContractDocumentType; label: string }> = (
	Object.keys(DOCUMENT_TYPE_LABELS) as ContractDocumentType[]
).map((value) => ({ value, label: DOCUMENT_TYPE_LABELS[value] }));

/** Columnas del catálogo que expone la API (mismo orden en todas las consultas). */
const TAX_DOCUMENT_TYPE_COLUMNS = `id, country_code, code, name, kind, is_electronic, sort`;

const toTaxDocumentType = (row: Row): TaxDocumentTypeOption => ({
	id: String(row.id),
	country_code: String(row.country_code),
	code: String(row.code),
	name: String(row.name ?? ''),
	kind: String(row.kind) as TaxDocumentTypeOption['kind'],
	is_electronic: row.is_electronic === true,
	sort: Number(row.sort ?? 0) || 0,
});

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
 * Condición de pago desde un texto de master data o de la cotización ("30 días", "Contado", "Fin de mes", "Fin de mes + 15",
 * "Día 5 del mes siguiente", "45"). Devuelve null si no se reconoce (se muestra como advertencia; la usuaria elige). Es la inversa de
 * `paymentTermsText` (`src/modules/quotes/quotes.service.ts`): Cotizaciones v2 guarda solo el texto canónico en `quotes.payment_terms`
 * y deriva `payment_terms_json` al leer con este parser, así que todo lo que emite `paymentTermsText` tiene que volver por aquí.
 */
export function parsePaymentTermsText(text: unknown): PaymentTerms | null {
	const clean = String(text ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase();

	if (!clean) return null;
	if (/^(contado|al contado|inmediato|0)$/.test(clean)) return { kind: 'net', days: 0 };
	const dayOfNextMonth = /^dia\s*(\d{1,2})\s*del\s*mes\s*siguiente$/.exec(clean);

	if (dayOfNextMonth) {
		const day = Number(dayOfNextMonth[1]);

		return day >= 1 && day <= 31 ? { kind: 'day_of_next_month', day } : null;
	}
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
	/** `companies.fx_company_policy` (default `monthly_avg` si la compañía no la tiene). */
	fx_company_policy: string;
}

/**
 * Tasa "para todo el contrato" (el formulario la manda sin fechas; decisión de Domi 01-10): se guarda con el **rango de los ítems del
 * contrato** (inicio del primero → fin del último, horizonte de 12 períodos si hay indefinidos). Al leer, una tasa única de un propósito
 * que cubre ese rango vuelve sin fechas ("Todo el contrato"). No convive con tasas por período del mismo propósito (400). Al extender el
 * plazo (renovación / modificación) corresponde extender esa tasa: pendiente del bloque de modificaciones.
 */
export const isWholeContractRate = (
	row: { period_start?: string | null; period_end?: string | null },
	coverage: { start: string | null; end: string | null }
) =>
	Boolean(coverage.start && coverage.end) &&
	String(row.period_start ?? '').slice(0, 10) <= String(coverage.start) &&
	String(row.period_end ?? '').slice(0, 10) >= String(coverage.end);
export const WHOLE_CONTRACT_RATE_CONFLICT =
	'Una tasa para todo el contrato (sin fechas) no puede convivir con tasas por período: deja solo esa o pon fechas a todas';

/**
 * Tasa fija lista para `contract_fx_period_rates` (regla "1 [from] = rate [to]"). `company`: contrato → compañía; `invoice`: moneda del ítem
 * (la del contrato sin multimoneda) → factura; `item`: moneda del ítem → contrato (multimoneda, métricas).
 */
export interface FxRateRow {
	purpose: 'company' | 'invoice' | 'item';
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
	/** Multimoneda: tasas pactadas ítem → contrato (`purpose = 'item'`), una (o varias por período) por moneda de ítem ≠ contrato. */
	item_rates: FxRateRow[];
	/** Multimoneda: `requires_multicurrency_billing` efectivo (body → cotización / guardado). */
	multicurrency: boolean;
}

interface DraftContext {
	company: CompanyRow;
	entity: { id: string; legal_name: string | null; country: string | null; payment_terms: PaymentTerms | null };
	client: { id: string; name: string | null };
	products: Map<string, string>;
	/** Documentos tributarios que puede emitir la compañía (su país, o los genéricos). */
	tax_document_types: TaxDocumentTypeOption[];
	/** Documento elegido en el body (ya validado contra el país de la compañía) o null. */
	tax_document_type: TaxDocumentTypeOption | null;
	/** Métricas facturables activas del holding referenciadas por los ítems medidos (id → nombre). */
	billable_metrics: Map<string, string>;
	/** Pricing v2 etapa 3: precios de catálogo referenciados por `items[].price_id` (ya validados: activos, mismo producto y moneda). */
	catalog_prices: Map<string, CatalogPrice>;
	/** Multimoneda: el flag cuando el body no lo trae (el de la cotización de origen al crear; el guardado al editar). */
	multicurrency_default: boolean;
}

/** Lo que la vista previa toma del contrato guardado además del formulario (mismo insumo que la activación). */
export interface EngineExtras {
	description_template?: ReturnType<typeof parseStoredTemplate>;
	contract_number?: string | null;
	description_max_chars?: number | null;
	/** Consumos registrados por id de ítem del borrador. */
	consumption?: Map<string, ConsumptionInput[]>;
}

/** Ítem existente de un borrador (`GET /contracts/:id/form` y `PUT /contracts/:id`). */
interface DraftItemRow {
	id: string;
	product_id: string | null;
	quote_item_id: string | null;
	/** Pricing v2: precio inline vigente del ítem (o null = standard fijo). */
	price_id: string | null;
	price: PriceSpec | null;
	price_version: number;
	/** Etapa 3: catálogo del que salió la copia (null en precios inline). */
	list_price_id: string | null;
	/** Moneda y producto de la fila de `prices` vigente: si cambian, el precio necesita versión nueva aunque el modelo sea igual. */
	price_currency?: string | null;
	price_product_id?: string | null;
}

/** Campos del encabezado que `PUT /contracts/:id` compara para resumir el cambio en el evento. */
const DRAFT_HEADER_FIELDS = [
	'client_id',
	'client_entity_id',
	'company_id',
	'contract_currency',
	'invoice_currency',
	'fx_invoice_policy',
	'fx_company_policy',
	'payment_terms',
	'document_type',
	'tax_document_type_id',
	'billing_anchor_day',
	'group_invoices_by_period',
	'auto_send_to_odoo',
	'auto_invoice',
	'booking_date',
	'salesforce_opportunity_id',
	'notes',
	'invoice_terms_and_conditions',
	'custom_fields',
	'requires_multicompany_billing',
	'requires_multicurrency_billing',
	'requires_references_for_billing',
	'total_value',
] as const;

/** Ítem ya resuelto: precios, fechas y nombre, listo para el motor y para el INSERT. */
interface ResolvedItem {
	key: string;
	dto: CreateContractItemDto;
	/** Multimoneda: moneda del ítem (default la del contrato). */
	currency: string;
	product_name: string;
	unit_price: number;
	is_recurring: boolean;
	price: number;
	discount_pct: number;
	final_price: number;
	/** Fin del ítem; `null` = sin término (S1-12): el generador factura un horizonte de 12 períodos. */
	end_date: string | null;
	/** Pricing v2: modelo de precio normalizado (inline o copiado del catálogo), o null = standard fijo de hoy. */
	price_spec: PriceSpec | null;
	/** Etapa 3: precio de catálogo elegido (`price_id`); la fila del contrato lo guarda en `list_price_id`. */
	list_price_id: string | null;
	/** Nombre del precio a guardar en la copia: el del catálogo, o el del producto en el inline. */
	price_name: string | null;
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

	/** Catálogo completo de documentos que un contrato puede emitir (factura local y de exportación de todos los países). */
	private async loadTaxDocumentTypes(db: Queryable): Promise<TaxDocumentTypeOption[]> {
		const rows = (await db.query(
			`SELECT ${TAX_DOCUMENT_TYPE_COLUMNS} FROM tax_document_types WHERE active = true AND kind = ANY($1::text[]) ORDER BY country_code, sort, code`,
			[[...CONTRACT_TAX_DOCUMENT_KINDS]]
		)) as Row[];

		return rows.map(toTaxDocumentType);
	}

	async formOptions(holdingId: string, now = new Date(), options: { clientEntityId?: string } = {}) {
		const year = Number(todayIso(now).slice(0, 4));
		const [companies, currencies, masterData, usedTypes, usedUnits, products, taxDocumentTypes, [entity], catalogPrices] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT id, legal_name, holding_name, country, currency, contract_prefix, tax_rate,
					COALESCE(fx_company_policy, 'monthly_avg') AS fx_company_policy, odoo_integration_id
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
			this.loadTaxDocumentTypes(this.dataSource),
			// País de la razón social receptora (si ya se eligió): decide factura local vs exportación en la sugerencia.
			options.clientEntityId
				? this.dataSource.query<Row[]>(`SELECT country FROM client_entities WHERE id = $1 AND holding_id = $2`, [
						options.clientEntityId,
						holdingId,
					])
				: Promise.resolve([] as Row[]),
			// Pricing v2 etapa 3: precios de catálogo publicados por producto (el formulario filtra por la moneda del contrato y
			// manda `items[].price_id`; el contrato recibe su copia con `list_price_id`).
			this.dataSource.query<Row[]>(
				`SELECT id, name, product_id, currency, version, model, quantity_type, billable_metric_id, unit_amount, tiers, package_size,
					package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount, invoice_line_mode, charge_flat_when_free
				FROM prices WHERE holding_id = $1 AND owner = 'catalog' AND status = 'active'
				ORDER BY product_id, currency, version DESC, name`,
				[holdingId]
			),
		]);
		const catalogByProduct = new Map<string, Array<Record<string, unknown>>>();

		for (const row of catalogPrices) {
			const productId = String(row.product_id);

			catalogByProduct.set(productId, [
				...(catalogByProduct.get(productId) ?? []),
				{
					id: String(row.id),
					name: toText(row.name) ?? '',
					version: toNumber(row.version) || 1,
					currency: String(row.currency ?? '').toUpperCase(),
					model: toText(row.model),
					quantity_type: toText(row.quantity_type),
					spec: priceSpecFromRow(row, ''),
				},
			]);
		}
		const entityCountry = toText(entity?.country);
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

		const usedTaxDocumentTypes = new Map<string, TaxDocumentTypeOption>();

		return {
			companies: companies.map((row) => {
				const prefix = contractPrefix(row.contract_prefix);
				const country = toText(row.country);
				const catalog = catalogForCountry(taxDocumentTypes, country);

				catalog.forEach((option) => usedTaxDocumentTypes.set(option.id, option));

				return {
					id: String(row.id),
					legal_name: toText(row.legal_name) ?? toText(row.holding_name),
					country,
					/** País ISO-2 normalizado desde el texto libre de `companies.country` (null si no se reconoce). */
					country_code: normalizeCountry(country),
					currency: toText(row.currency),
					contract_prefix: toText(row.contract_prefix),
					tax_rate: normalizeTaxRate(row.tax_rate as number | null),
					/** Política por defecto para devengar en su moneda (`company_default` del contrato la copia). */
					fx_company_policy: toText(row.fx_company_policy) ?? 'monthly_avg',
					/**
					 * La compañía puede enviar facturas al ERP (mismo criterio del scheduler: `odoo_integration_id` asignado). Sin
					 * integración, el envío y la emisión automáticos del contrato no operan (bloqueo `no_erp_integration`).
					 */
					erp_integration_enabled: row.odoo_integration_id !== null && row.odoo_integration_id !== undefined,
					next_number: formatContractNumber(prefix, year, nextByPrefix.get(prefix) ?? 1),
					/** Documentos que puede emitir esta compañía (los de su país; si no tiene, los genéricos). */
					tax_document_types: catalog,
					/** Sugerido: exportación si la razón social (`?client_entity_id`) es de otro país; si no, factura local. */
					suggested_tax_document_type_id: suggestTaxDocumentType(catalog, country, entityCountry)?.id ?? null,
				};
			}),
			/** Unión de los catálogos de las compañías del holding (para resolver un id sin recorrer `companies`). */
			tax_document_types: [...usedTaxDocumentTypes.values()],
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
				/** Precios de catálogo activos del producto (`{ id, name, version, currency, model, quantity_type, spec }`). */
				catalog_prices: catalogByProduct.get(String(row.id)) ?? [],
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
				q.client_id, q.requires_multicompany, q.requires_multicurrency, q.requires_references_for_billing,
				cl.name_commercial AS client_name, qs.name AS stage_name, qs.kind AS stage_kind
			FROM quotes q
			LEFT JOIN clients cl ON cl.id = q.client_id AND cl.holding_id = q.holding_id
			LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
			WHERE q.id = $1 AND q.holding_id = $2 AND q.deleted_at IS NULL`,
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
					qi.billing_method, qi.start_date, qi.term_months, qi.is_recurring, qi.auto_renew, qi.auto_renew_term_months,
					qi.price_id AS item_price_id, ${PRICE_COLUMNS}
				FROM quote_items qi
				LEFT JOIN prices p ON p.id = qi.price_id
				WHERE qi.quote_id = $1 AND qi.holding_id = $2
				ORDER BY qi.product_name, qi.id`,
				[quoteId, holdingId]
			),
		]);
		const warnings: string[] = [];
		// Cotizaciones v2 (Q-D4): la condición estructurada se deriva del texto canónico de `payment_terms` (no hay columna json).
		const paymentTerms = parsePaymentTermsText(quote.payment_terms);

		if (quote.payment_terms && !paymentTerms) {
			warnings.push(
				`La cotización trae la condición de pago "${String(quote.payment_terms)}", que no se pudo interpretar: elígela en el contrato`
			);
		}
		// Cotizaciones v2 (Q-A1): la etapa se reconoce por `kind`; sin kind, por nombre como antes.
		const signed = quote.stage_kind
			? quote.stage_kind === 'signed'
			: String(quote.stage_name ?? '')
					.trim()
					.toLowerCase() === 'firmada';

		if (quote.stage_name && !signed) {
			warnings.push(`La cotización está en la etapa "${String(quote.stage_name)}", no Firmada`);
		}
		if (!clientId) warnings.push('La cotización no tiene cliente comercial: elígelo en el contrato');
		if (clientId && entities.length === 0) warnings.push('El cliente no tiene razones sociales: crea una antes de guardar el contrato');

		const mappedItems = items.map((row) => {
			const quantity = toNumber(row.quantity) || 1;
			// Un recurrente cotizado sin plazo queda sin término (NULL, S1-12: horizonte de 12 períodos), no con 12 meses inventados.
			const recurring = row.is_recurring !== false;
			const term = toNumber(row.term_months) || (recurring ? null : 12);
			const termForPrice = term ?? indefiniteHorizonMonths({ billing_frequency: toText(row.billing_frequency) ?? 'Mensual' });
			const annual = row.price_entry_mode === 'annual';
			const unitPrice =
				row.unit_price !== null && row.unit_price !== undefined
					? toNumber(row.unit_price)
					: round2(toNumber(row.price) / (quantity * termForPrice));
			// Cotizaciones v2 (Q-A3): el modelo de precio del ítem cotizado se copia al contrato como precio inline (owner = contract).
			const priceSpec = row.item_price_id ? priceSpecFromRow(row) : null;
			let discount = toNumber(row.discount_value);

			if (discount > 0 && row.discount_type === 'Monto fijo') {
				discount =
					round2(discountPct({ discount_value: discount, discount_type: 'Monto fijo' }, unitPrice * quantity * termForPrice) * 100) / 100;
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
				...(priceSpec && !(priceSpec.model === 'standard' && priceSpec.quantity_type === 'fixed') ? { price: priceSpec } : {}),
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
				/** S1-15: marcas de facturación de la cotización; el formulario las propone y la usuaria decide. */
				requires_multicompany_billing: quote.requires_multicompany === true,
				requires_multicurrency_billing: quote.requires_multicurrency === true,
				requires_references_for_billing: quote.requires_references_for_billing === true,
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
			`SELECT c.contract_number FROM contracts c WHERE c.quote_id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1`,
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
		const metricIds = [
			...new Set(dto.items.map((item) => item.price?.billable_metric_id).filter((id): id is string => typeof id === 'string' && id.length > 0)),
		];
		const [[company], [entity], [client], products, currencies, taxDocumentTypes, metrics, catalogPrices, [quoteFlags]] = await Promise.all([
			db.query(
				`SELECT id, legal_name, country, currency, contract_prefix, tax_rate,
					COALESCE(fx_company_policy, 'monthly_avg') AS fx_company_policy
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
			this.loadTaxDocumentTypes(db),
			metricIds.length
				? (db.query(`SELECT id, name, status FROM billable_metrics WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
						metricIds,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			loadCatalogPrices(db, catalogPriceIds(dto.items), holdingId),
			// Multimoneda: sin flag en el body, el de la cotización de origen (`quotes.requires_multicurrency`).
			dto.quote_id
				? (db.query(`SELECT q.requires_multicurrency FROM quotes q WHERE q.id = $1 AND q.holding_id = $2`, [
						dto.quote_id,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const errors: CodedFieldError[] = [];
		const metricsById = new Map(metrics.map((row) => [String(row.id), row]));

		if (!client) errors.push({ field: 'client_id', message: 'El cliente no existe en el holding' });
		if (!entity) errors.push({ field: 'client_entity_id', message: 'La razón social no existe en el holding' });
		else if (client && entity.belongs !== true) errors.push({ field: 'client_entity_id', message: 'La razón social no pertenece al cliente' });
		if (!company) errors.push({ field: 'company_id', message: 'La compañía no existe en el holding' });
		// S6-10: la emisión automática solo tiene sentido si la factura viaja sola al ERP.
		if (dto.auto_invoice === true && dto.auto_send_to_odoo !== true) {
			errors.push({ field: 'auto_invoice', message: 'La emisión automática requiere el envío automático al ERP' });
		}

		// Documento tributario: solo los del país de la compañía emisora (o los genéricos si el país no tiene catálogo).
		const companyCatalog = company ? catalogForCountry(taxDocumentTypes, toText(company.country)) : [];
		const taxDocumentType = dto.tax_document_type_id ? (companyCatalog.find((row) => row.id === dto.tax_document_type_id) ?? null) : null;

		if (company && dto.tax_document_type_id && !taxDocumentType) {
			errors.push({ field: 'tax_document_type_id', message: TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE });
		}

		const knownCurrencies = new Set(currencies.map((row) => String(row.code)));

		if (knownCurrencies.size && !knownCurrencies.has(dto.contract_currency)) {
			errors.push({ field: 'contract_currency', message: `La moneda ${dto.contract_currency} no está habilitada` });
		}
		if (knownCurrencies.size && dto.invoice_currency && !knownCurrencies.has(dto.invoice_currency)) {
			errors.push({ field: 'invoice_currency', message: `La moneda ${dto.invoice_currency} no está habilitada` });
		}

		const productNames = new Map(products.map((row) => [String(row.id), String(row.name ?? '')]));
		const seenKeys = new Set<string>();
		const multicurrency = dto.requires_multicurrency_billing ?? quoteFlags?.requires_multicurrency === true;

		dto.items.forEach((item, index) => {
			// Multimoneda (spec §6): un ítem en otra moneda solo con el flag; la moneda debe estar habilitada.
			const itemCurrency = upperCode(item.currency) || upperCode(dto.contract_currency);

			if (item.currency && knownCurrencies.size && !knownCurrencies.has(itemCurrency)) {
				errors.push({ field: `items.${index}.currency`, message: `La moneda ${itemCurrency} no está habilitada` });
			} else if (itemCurrency !== upperCode(dto.contract_currency) && !multicurrency) {
				errors.push({
					field: `items.${index}.currency`,
					message: `El ítem está en ${itemCurrency} y el contrato en ${upperCode(dto.contract_currency)}: activa "Facturar ítems en distintas monedas" o usa la moneda del contrato`,
					code: MULTICURRENCY_CODES.item_currency_requires_multicurrency,
				});
			}
			if (!productNames.has(item.product_id))
				errors.push({ field: `items.${index}.product_id`, message: 'El producto no existe en el catálogo del holding' });
			if (item.key) {
				if (seenKeys.has(item.key)) errors.push({ field: `items.${index}.key`, message: 'Ítem repetido' });
				seenKeys.add(item.key);
			}
			if (item.price_entry_mode === 'annual' && (item.annual_unit_price === undefined || item.annual_unit_price === null)) {
				errors.push({ field: `items.${index}.annual_unit_price`, message: 'Escribe el precio anual' });
			}
			if (item.is_recurring === false && (item.term_months === null || item.term_months === undefined)) {
				errors.push({
					field: `items.${index}.term_months`,
					message: 'Un ítem de pago único necesita plazo: sin término es solo para recurrentes',
				});
			}
			// Pricing v2: el precio inline se valida completo (tramos, métrica, mínimo/tope); el de catálogo (etapa 3) debe estar
			// activo, ser del mismo producto y de la moneda del contrato, y no venir junto a un inline. Ambos: medido + Anticipado → 400 salvo seat.
			if (item.price_id) {
				const catalog = catalogPrices.get(item.price_id);

				errors.push(
					...catalogPriceErrors({
						field: `items.${index}`,
						catalog,
						inline: hasPricingModel(item),
						product_id: item.product_id,
						// Multimoneda: el precio debe estar en la moneda del ítem (400 price_currency_mismatch).
						contract_currency: upperCode(item.currency) || dto.contract_currency,
					})
				);
				if (catalog && isMetered(catalog.spec) && item.billing_method === 'Anticipado' && catalog.spec.model !== 'seat') {
					errors.push({ field: `items.${index}.billing_method`, message: METERED_ADVANCE_MESSAGE });
				}
			}
			if (item.price) {
				validatePriceSpec(item.price).forEach((error) =>
					errors.push({ field: `items.${index}.price.${error.field}`, message: error.message })
				);
				if (isMetered(item.price)) {
					const metric = item.price.billable_metric_id ? metricsById.get(item.price.billable_metric_id) : undefined;

					if (item.price.billable_metric_id && !metric) {
						errors.push({ field: `items.${index}.price.billable_metric_id`, message: 'La métrica facturable no existe en el holding' });
					} else if (metric && metric.status !== 'active') {
						errors.push({ field: `items.${index}.price.billable_metric_id`, message: 'La métrica facturable está archivada' });
					}
					if (item.billing_method === 'Anticipado' && item.price.model !== 'seat') {
						errors.push({ field: `items.${index}.billing_method`, message: METERED_ADVANCE_MESSAGE });
					}
				}
				if (!hasPricingModel(item) && item.price_entry_mode !== 'annual' && (item.unit_price === undefined || item.unit_price === null)) {
					errors.push({ field: `items.${index}.unit_price`, message: 'Escribe el precio unitario' });
				}
			}
		});

		if (errors.length) throw codedValidationException(errors);

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
			tax_document_types: companyCatalog,
			tax_document_type: taxDocumentType,
			billable_metrics: new Map(metrics.map((row) => [String(row.id), String(row.name ?? '')])),
			catalog_prices: catalogPrices,
			multicurrency_default: quoteFlags?.requires_multicurrency === true,
		};
	}

	/**
	 * Precios, fin y nombre de cada ítem (unitario mensual; el anual se divide en 12 como `auto_calculate_pricing_fields`).
	 * Con `price_id` el modelo es el del catálogo (ya validado en `loadContext`) y la copia del contrato lo recordará en `list_price_id`.
	 */
	static resolveItems(dto: CreateContractDto, products: Map<string, string>, catalogPrices: Map<string, CatalogPrice> = new Map()): ResolvedItem[] {
		return dto.items.map((item, index) => {
			const catalog = item.price_id ? (catalogPrices.get(item.price_id) ?? null) : null;
			const price = catalog ? normalizePriceSpec(catalog.spec) : hasPricingModel(item) ? normalizePriceSpec(item.price!) : null;
			// Con modelo de precio, el unitario guardado reproduce el mensual equivalente del motor (MRR del 360 = MRR de la vista previa).
			const unitPrice = price
				? ContractDraftsService.equivalentMonthlyUnit(price, item, Number(item.discount_value ?? 0) || 0)
				: item.price_entry_mode === 'annual'
					? Number(item.annual_unit_price ?? 0) / 12
					: Number(item.unit_price ?? 0);
			// Sin término: el valor del ítem se mide sobre el horizonte de 12 períodos (mismo que las facturas generadas).
			const pricing = itemPricing({
				quantity: item.quantity,
				unit_price: unitPrice,
				term_months: item.term_months,
				billing_frequency: item.billing_frequency,
				discount_value: item.discount_value,
			});

			return {
				key: item.key || `item-${index + 1}`,
				dto: item,
				currency: upperCode(item.currency) || upperCode(dto.contract_currency),
				product_name: item.product_name?.trim() || products.get(item.product_id) || 'Producto',
				unit_price: unitPrice,
				is_recurring: item.is_recurring !== false,
				price: pricing.price,
				discount_pct: pricing.discount_pct,
				final_price: pricing.final_price,
				end_date: isIndefiniteItem({ ...item, is_recurring: item.is_recurring !== false })
					? null
					: itemEndDate(item.start_date, Number(item.term_months) || 0),
				price_spec: price,
				list_price_id: catalog?.id ?? null,
				price_name: catalog?.name ?? null,
			};
		});
	}

	/**
	 * Pricing v2: unitario **mensual equivalente** de un ítem con modelo de precio, para las columnas de hoy
	 * (`unit_price`, `monthly_price`, `billing_period_price`, MRR/RSM). Las columnas calculan `monthly_price = unitario ×
	 * cantidad × (1 − descuento %)`; el unitario se elige para que ese resultado sea el mensual equivalente del motor
	 * (`pricedMonthlyEquivalent`: un período completo con el descuento del ítem, ÷ meses de la frecuencia), el mismo que la
	 * vista previa suma en `totals.mrr`. Así el MRR del 360 coincide con el de la vista previa aunque haya mínimo o tope.
	 * Sin descuento (default, lo usan cotizaciones y modificaciones) es el precio del período ÷ cantidad ÷ meses. Supuesto:
	 * para lo medido usa la cantidad base (la misma que hereda una línea pendiente).
	 */
	static equivalentMonthlyUnit(
		price: PriceSpec,
		item: Pick<CreateContractItemDto, 'quantity' | 'billing_frequency' | 'is_recurring' | 'term_months'>,
		discountPct = 0
	): number {
		const quantity = Number(item.quantity) || 0;

		if (quantity <= 0) return 0;
		const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
		// Con 100 % de descuento el mensual es 0 con cualquier unitario: se guarda el de lista.
		const monthly = pricedMonthlyEquivalent(price, { ...item, is_recurring: item.is_recurring !== false }, pct < 100 ? pct : 0);
		const gross = pct < 100 ? monthly / (1 - pct / 100) : monthly;

		return Math.round((gross / quantity) * 1e6) / 1e6;
	}

	// ---------------------------------------------------------------- vista previa de precio (Pricing v2)

	/** `POST /contracts/price-preview`: un `PricedLine` por cantidad simulada. No toca la base. */
	static pricePreview(dto: PricePreviewDto): PricedLine[] {
		const errors = validatePriceSpec(dto.price).map((error) => ({ field: `price.${error.field}`, message: error.message }));

		if (errors.length) throw validationException(errors);
		const price = normalizePriceSpec(dto.price);

		return dto.quantities.map((quantity) => priceLine(price, quantity, dto.discount_pct ?? 0));
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
		const errors: CodedFieldError[] = [];
		const multicurrency = dto.requires_multicurrency_billing ?? context.multicurrency_default;
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
		// Multimoneda (spec §2): monedas de los ítems; los pares que convierten al facturar son las monedas de ítem ≠ moneda de factura
		// (sin multimoneda: solo la del contrato, como hasta hoy).
		const itemCurrencies = [...new Set(items.map((item) => item.currency))];
		const foreignCurrencies = itemCurrencies.filter((code) => code !== contractCurrency);
		const convertingCurrencies = multicurrency
			? itemCurrencies.filter((code) => code !== invoiceCurrency)
			: invoiceCurrency !== contractCurrency
				? [contractCurrency]
				: [];
		const invoiceFx = convertingCurrencies.length > 0;
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
		// Un ítem sin término cubre el horizonte de 12 períodos (`indefinite_until` del generador), no "sin fin": así una tasa sin fin
		// en un contrato con ítems indefinidos queda con el mismo fin que las facturas generadas en vez de rechazarse.
		const ends = items
			.map(
				(item) =>
					item.end_date ?? itemEndDate(item.dto.start_date, indefiniteHorizonMonths({ billing_frequency: item.dto.billing_frequency }))
			)
			.sort();
		const coverageStart = starts[0];
		const coverageEnd = ends[ends.length - 1];
		/**
		 * Normaliza las tasas de un propósito. La regla "tasa sin fechas = todo el contrato" (y su conflicto con tasas por período), el fin >
		 * inicio y los solapes se evalúan **por par** `(propósito, from, to)` (spec-multimoneda §6).
		 */
		const normalize = (
			rates: Array<FxRatePeriodDto & { from_currency?: string }> | undefined,
			field: 'fx_invoice_rates' | 'fx_company_rates' | 'fx_item_rates',
			purpose: FxRateRow['purpose'],
			toCurrency: string,
			defaultFrom: string
		): FxRateRow[] => {
			const rows = (rates ?? []).map((rate, index) => {
				const whole = !rate.period_start && !rate.period_end;

				return {
					index,
					whole,
					row: {
						purpose,
						from_currency: upperCode(rate.from_currency) || defaultFrom,
						to_currency: toCurrency,
						rate: Number(rate.rate),
						period_start: rate.period_start ?? coverageStart,
						period_end: rate.period_end ?? coverageEnd,
					},
				};
			});

			for (const from of [...new Set(rows.map(({ row }) => row.from_currency))]) {
				const pairRows = rows.filter(({ row }) => row.from_currency === from);
				const whole = pairRows.find((entry) => entry.whole);

				// Una tasa sin fechas cubre todo: con otras del mismo par se superpondría siempre.
				if (whole && pairRows.length > 1) {
					errors.push({ field: `${field}.${whole.index}`, message: WHOLE_CONTRACT_RATE_CONFLICT });
					continue;
				}
				pairRows.forEach(({ index, row }) => {
					if (!(row.period_end > row.period_start)) {
						errors.push({ field: `${field}.${index}.period_end`, message: 'El fin de la tasa debe ser posterior a su inicio' });
					}
				});
				const sorted = [...pairRows].sort((a, b) => a.row.period_start.localeCompare(b.row.period_start));

				sorted.slice(1).forEach(({ index, row }, position) => {
					const previous = sorted[position].row;

					if (row.period_start <= previous.period_end) {
						errors.push({
							field: `${field}.${index}.period_start`,
							message: `La tasa se superpone con la del ${previous.period_start} al ${previous.period_end}`,
						});
					}
				});
			}

			return rows.map(({ row }) => row);
		};
		const invoiceRates =
			invoiceFx && dto.fx_invoice_policy === 'fixed'
				? normalize(dto.fx_invoice_rates, 'fx_invoice_rates', 'invoice', invoiceCurrency, contractCurrency)
				: [];

		// Multimoneda: cada tasa de facturación es de un par que convierte (moneda de ítem ≠ factura).
		invoiceRates.forEach((row, index) => {
			if (!convertingCurrencies.includes(row.from_currency)) {
				errors.push({
					field: `fx_invoice_rates.${index}.from_currency`,
					message: `Ningún ítem en ${row.from_currency} se factura en ${invoiceCurrency}: la tasa no aplica`,
				});
			}
		});
		if (multicurrency && convertingCurrencies.length > 1) {
			(dto.fx_invoice_rates ?? []).forEach((rate, index) => {
				if (!rate.from_currency)
					errors.push({ field: `fx_invoice_rates.${index}.from_currency`, message: 'Indica de qué moneda es la tasa (hay más de un par)' });
			});
		}
		const companyRates =
			companyFx && dto.fx_company_policy === 'fixed_period'
				? normalize(dto.fx_company_rates, 'fx_company_rates', 'company', companyCurrency!, contractCurrency)
				: [];
		// Multimoneda (spec §5): tasa pactada ítem → contrato obligatoria por cada moneda de ítem ≠ contrato.
		const itemRates = normalize(dto.fx_item_rates, 'fx_item_rates', 'item', contractCurrency, contractCurrency);

		if (dto.fx_item_rates?.length && !multicurrency) {
			errors.push({ field: 'fx_item_rates', message: 'Las tasas ítem → contrato solo aplican a contratos multimoneda' });
		}
		itemRates.forEach((row, index) => {
			if (row.from_currency === contractCurrency || !foreignCurrencies.includes(row.from_currency)) {
				errors.push({
					field: `fx_item_rates.${index}.from_currency`,
					message: `Ningún ítem está en ${row.from_currency} (distinta de ${contractCurrency}): la tasa no aplica`,
				});
			}
		});
		if (multicurrency) {
			for (const code of foreignCurrencies.filter((currency) => !itemRates.some((row) => row.from_currency === currency))) {
				errors.push({
					field: 'fx_item_rates',
					message: `Falta la tasa pactada ${code} → ${contractCurrency} para métricas (MRR, valor del contrato y devengo)`,
					code: MULTICURRENCY_CODES.item_fx_rate_missing,
				});
			}
		}

		if (errors.length) throw codedValidationException(errors);

		return {
			invoice_currency: invoiceCurrency,
			fx_invoice_policy: invoiceFx ? (dto.fx_invoice_policy ?? 'spot') : 'spot',
			fx_invoice_confirmed: invoiceFx,
			fx_company_policy: companyFx && dto.fx_company_policy === 'fixed_period' ? 'fixed_period' : context.company.fx_company_policy,
			fx_company_confirmed: companyFx,
			invoice_rates: invoiceRates,
			company_rates: companyRates,
			item_rates: itemRates,
			multicurrency,
		};
	}

	/** Valor total del contrato (TCV) en moneda de contrato: Σ `final_price` × tasa pactada ítem → contrato (1 en la moneda del contrato). */
	static totalValue(items: ResolvedItem[], contractCurrency: string, fx: Pick<ResolvedFx, 'item_rates'>): number {
		return round2(
			items.reduce(
				(sum, item) => sum + toContractCurrency(item.final_price, item.currency, contractCurrency, fx.item_rates, item.dto.start_date),
				0
			)
		);
	}

	/** Defaults del contrato a partir del DTO y el contexto (mismos en la vista previa y al guardar). */
	static contractDefaults(dto: CreateContractDto, context: DraftContext, items: ResolvedItem[]) {
		// Documento tributario: el elegido, o el sugerido por país emisor vs receptor dentro del catálogo de la compañía. Con
		// documento, la familia `document_type` se deriva de él; sin catálogo (país sin filas y sin genéricos), la regla vieja.
		const taxDocumentType =
			context.tax_document_type ?? suggestTaxDocumentType(context.tax_document_types, context.company.country, context.entity.country);
		const documentType: ContractDocumentType = taxDocumentType
			? documentTypeFromKind(taxDocumentType.kind)
			: dto.document_type && (CONTRACT_DOCUMENT_TYPES as readonly string[]).includes(dto.document_type)
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
			tax_document_type: taxDocumentType,
			tax_document_type_id: taxDocumentType?.id ?? null,
			// Día de ciclo automático (decisión de Domi 01-10): sin valor explícito se guarda NULL y el generador usa el día del primer
			// recurrente; solo un día elegido por la usuaria se guarda.
			billing_anchor_day: dto.billing_anchor_day ?? null,
			group_invoices_by_period: dto.group_invoices_by_period ?? true,
		};
	}

	static engineInput(dto: CreateContractDto, context: DraftContext, items: ResolvedItem[], extras: EngineExtras = {}): BillingEngineInput {
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
				// Multimoneda: tasas pactadas ítem → contrato (totales en moneda de contrato).
				fixed_item_rates: defaults.fx.item_rates,
				multicurrency: defaults.fx.multicurrency,
				payment_terms: defaults.payment_terms,
				document_type: defaults.document_type,
				company: { country: context.company.country, tax_rate: context.company.tax_rate },
				entity_country: context.entity.country,
				// Glosas como en la activación (spec facturas §3.6): plantilla del contrato, contexto y límite del documento.
				description_template: extras.description_template ?? null,
				description_context: {
					contract_number: extras.contract_number ?? dto.contract_number ?? null,
					client_name: context.entity.legal_name,
				},
				description_max_chars: extras.description_max_chars ?? null,
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
					term_months: item.dto.term_months ?? null,
					end_date: item.end_date,
					is_recurring: item.is_recurring,
					final_price: item.final_price,
					price: item.price_spec,
					// Consumos ya registrados del ítem (borrador guardado): la vista previa los respeta igual que la activación.
					consumption: extras.consumption?.get((item.dto as UpdateContractItemDto).id ?? item.key) ?? [],
					currency: item.currency,
				})
			),
		};
	}

	/** Límite de la glosa del documento del borrador (mismo cálculo que la activación con `descriptionMaxCharsOfRow`). */
	private async descriptionMaxChars(db: Queryable, dto: CreateContractDto, context: DraftContext, items: ResolvedItem[]) {
		const defaults = ContractDraftsService.contractDefaults(dto, context, items);
		const [row] = (await db.query(
			`SELECT ${DESCRIPTION_LIMITS_SQL} AS description_limits,
				(SELECT t.description_max_chars FROM tax_document_types t WHERE t.id = $1::uuid) AS own_description_max_chars`,
			[defaults.tax_document_type_id]
		)) as Row[];

		return descriptionMaxCharsOfRow({
			...(row ?? {}),
			tax_document_type_id: defaults.tax_document_type_id,
			company_country: context.company.country,
			document_type: defaults.document_type,
		});
	}

	// ---------------------------------------------------------------- vista previa

	async preview(dto: CreateContractDto, holdingId: string, extras: EngineExtras = {}) {
		const context = await this.loadContext(this.dataSource, dto, holdingId);
		const items = ContractDraftsService.resolveItems(dto, context.products, context.catalog_prices);
		const maxChars = await this.descriptionMaxChars(this.dataSource, dto, context, items);

		return generateInvoices(ContractDraftsService.engineInput(dto, context, items, { description_max_chars: maxChars, ...extras }));
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
			// Costura `sapira.writer = 'api'`: primera sentencia; los triggers legacy no rellenan nada, la API escribe cada campo.
			await setApiWriter(runner);
			const context = await this.loadContext(runner, dto, holdingId);
			const items = ContractDraftsService.resolveItems(dto, context.products, context.catalog_prices);
			const defaults = ContractDraftsService.contractDefaults(dto, context, items);
			const quote = dto.quote_id ? await this.lockQuote(runner, dto, holdingId) : null;
			const contractNumber = await this.reserveNumber(runner, dto, context, holdingId, now);
			const [settings] = (await runner.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [
				holdingId,
			])) as Row[];
			const systemCurrency = toText(settings?.system_currency) ?? 'USD';
			// TCV en moneda de contrato: los ítems en otra moneda convierten con su tasa pactada ítem → contrato (multimoneda §5).
			const totalValue = ContractDraftsService.totalValue(items, dto.contract_currency, defaults.fx);
			// Compatibilidad con los consumidores actuales: fin del contrato = el mayor fin de los recurrentes; con un
			// recurrente sin término queda NULL. v2 muestra además el próximo vencimiento por ítem (`next_item_end_date`).
			const contractEnd = ContractDraftsService.contractEndDate(items);
			const bookingDate = dto.booking_date ?? toIsoDate(quote?.booking_date) ?? null;
			const flags = { ...ContractDraftsService.billingFlags(dto, quote), requires_multicurrency_billing: defaults.fx.multicurrency };

			const [inserted] = (await runner.query(
				`INSERT INTO contracts (
					holding_id, client_id, client_entity_id, company_id, quote_id, contract_number, type, status,
					total_value, legal_client_name, client_name_commercial, notes, current_step_id, workflow_started_at,
					booking_date, contract_end_date, contract_currency, system_currency, fx_rate_to_system, total_value_system_currency,
					company_currency, fx_company_policy, fx_invoice_policy, invoice_currency,
					requires_multicompany_billing, requires_multicurrency_billing, requires_references_for_billing, requires_contract_document,
					custom_fields, auto_invoice, auto_send_to_odoo, group_invoices_by_period, salesforce_opportunity_id,
					invoice_terms_and_conditions, billing_anchor_day, payment_terms, document_type, tax_document_type_id,
					fx_invoice_confirmed_at, fx_company_confirmed_at
				) VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8,
					$9, $10, $11, $12, NULL, NULL,
					$13, $14, $15, $16, $17, $18,
					$19, $20, $21, $22,
					$23, $24, $25, $26,
					$27::jsonb, $28, $29, $30, $31,
					$32, $33, $34::jsonb, $35, $36,
					CASE WHEN $37::boolean THEN now() END, CASE WHEN $38::boolean THEN now() END
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
					flags.requires_multicompany_billing,
					flags.requires_multicurrency_billing,
					flags.requires_references_for_billing,
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
					defaults.tax_document_type_id,
					defaults.fx.fx_invoice_confirmed,
					defaults.fx.fx_company_confirmed,
				]
			)) as Row[];

			contractId = String(inserted.id);
			const quoteItems = await this.quoteItems(runner, dto, quote);
			const itemIds: string[] = [];

			for (const item of items) {
				const quoteItem = item.dto.quote_item_id ? quoteItems.get(item.dto.quote_item_id) : undefined;
				const itemId = await this.insertItem(runner, contractId, holdingId, item, quoteItem, bookingDate);

				itemIds.push(itemId);
				// Pricing v2: el precio inline nace en la misma transacción (owner = contract) y el ítem lo apunta, en la moneda del ítem.
				if (item.price_spec) await this.insertPrice(runner, { contractId, holdingId, itemId, item, currency: item.currency, userId });
			}

			// `contracts.term` = mayor plazo de los ítems (antes `update_contract_term`).
			await syncContractTerm(runner, contractId, holdingId);
			// Tasas fijas de facturación y de compañía, con su propósito, en la misma transacción.
			await this.insertFxRates(runner, contractId, holdingId, defaults.fx, userId, 'Cargada al crear el contrato (v2)');

			const quoteStageUpdated = quote
				? await this.markQuoteContractCreated(runner, String(quote.id), holdingId, {
						id: contractId,
						contract_number: contractNumber,
						userId,
					})
				: false;

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

	// ---------------------------------------------------------------- ítems y tasas (crear y editar)

	/** Fin del contrato = el mayor fin de los recurrentes; `null` sin recurrentes o si alguno no tiene término. */
	static contractEndDate(items: ResolvedItem[]): string | null {
		const recurringEnds = items.filter((item) => item.is_recurring).map((item) => item.end_date);

		if (!recurringEnds.length || recurringEnds.some((end) => end === null)) return null;

		return [...(recurringEnds as string[])].sort().reverse()[0];
	}

	/**
	 * Marcas de facturación (S1-15): lo que diga el body; si no viene, lo que traiga la cotización de origen; si no, false.
	 */
	static billingFlags(
		dto: Pick<CreateContractDto, 'requires_multicompany_billing' | 'requires_multicurrency_billing' | 'requires_references_for_billing'>,
		quote: Row | null | undefined
	) {
		return {
			requires_multicompany_billing: dto.requires_multicompany_billing ?? quote?.requires_multicompany === true,
			requires_multicurrency_billing: dto.requires_multicurrency_billing ?? quote?.requires_multicurrency === true,
			requires_references_for_billing: dto.requires_references_for_billing ?? quote?.requires_references_for_billing === true,
		};
	}

	/**
	 * Precios derivados del ítem (antes `auto_calculate_pricing_fields`): en modo anual el unitario mensual = anual ÷ 12, el
	 * anual y el total anual, `monthly_price` y `billing_period_price`. Réplica exacta del trigger (`pricingFields`).
	 */
	static itemPricingFields(item: ResolvedItem) {
		// Con modelo de precio el unitario guardado es el mensual equivalente del motor (`equivalentMonthlyUnit`), aunque el
		// formulario venga en modo anual: el modo anual solo aplica al precio estándar (si no, `monthly_price` ≠ MRR del motor).
		const annual = item.dto.price_entry_mode === 'annual' && !item.price_spec;

		return pricingFields(
			{
				unit_price: annual ? null : item.unit_price,
				annual_unit_price: annual ? (item.dto.annual_unit_price ?? null) : null,
				price_entry_mode: annual ? 'annual' : 'monthly',
				quantity: item.dto.quantity,
				billing_frequency: item.dto.billing_frequency,
				is_recurring: item.is_recurring,
				final_price: item.final_price,
				term_months: item.dto.term_months ?? null,
				discount_type: item.discount_pct > 0 ? 'Porcentaje' : null,
				discount_value: item.discount_pct,
			},
			'contract_items'
		);
	}

	/**
	 * Valores de un ítem resuelto para `contract_items` (mismos en INSERT y UPDATE). Con la costura la API escribe todo lo que
	 * antes derivaban triggers: precios (`itemPricingFields`), fin explícito (`set_contract_item_end_date`) y `auto_renew` tal
	 * como lo eligió la usuaria (`inherit_auto_renew_from_quote_item` ya no lo pisa, S1-5).
	 */
	private static itemValues(item: ResolvedItem, quoteItem: Row | undefined, bookingDate: string | null) {
		const prices = ContractDraftsService.itemPricingFields(item);

		return [
			item.dto.product_id,
			item.product_name,
			item.dto.account || null,
			item.dto.item_type,
			item.dto.unit_of_measure || null,
			item.dto.quantity,
			prices.unit_price,
			prices.annual_unit_price,
			prices.price_entry_mode,
			item.discount_pct > 0 ? 'Porcentaje' : null,
			item.discount_pct,
			item.price,
			item.final_price,
			// S1-2: el ítem hereda la moneda del contrato; multimoneda: la suya (validada contra el flag en `loadContext`).
			item.currency,
			item.dto.billing_frequency,
			item.dto.billing_method,
			item.dto.start_date,
			// Inicio + término − 1 día; sin término, NULL.
			item.end_date,
			item.dto.term_months ?? null,
			item.is_recurring,
			item.dto.quote_item_id ?? null,
			toText(quoteItem?.quote_item_number),
			item.dto.auto_renew ?? false,
			item.dto.auto_renew_term_months ?? null,
			item.dto.booking_date ?? bookingDate,
			prices.annual_price,
			prices.monthly_price,
			prices.billing_period_price,
		];
	}

	/**
	 * INSERT de un ítem con todo explícito: precios, fin, `auto_renew` y la categoría (NEW / UPSELL / CROSS-SELL por historial
	 * del cliente, `itemCategoriaSql`: la regla de `trg_set_contract_item_categoria` sin contar borradores borrados). Devuelve el id.
	 */
	private async insertItem(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		item: ResolvedItem,
		quoteItem: Row | undefined,
		bookingDate: string | null
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO contract_items (
				contract_id, holding_id, product_id, product_name, account, item_type, unit_of_measure,
				quantity, unit_price, annual_unit_price, price_entry_mode, discount_type, discount_value,
				price, final_price, currency, billing_frequency, billing_method, start_date, end_date, term_months,
				is_recurring, quote_item_id, quote_item_number, auto_renew, auto_renew_term_months, booking_date,
				annual_price, monthly_price, billing_period_price, custom_fields, categoria
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7,
				$8, $9, $10, $11, $12, $13,
				$14, $15, $16, $17, $18, $19, $20, $21,
				$22, $23, $24, $25, $26, $27,
				$28, $29, $30, $31::jsonb,
				${itemCategoriaSql(1, 3)}
			) RETURNING id`,
			[contractId, holdingId, ...ContractDraftsService.itemValues(item, quoteItem, bookingDate), JSON.stringify(quoteItem?.custom_fields ?? {})]
		)) as Row[];

		return String(row.id);
	}

	/**
	 * Pricing v2: INSERT en `prices` (owner = contract, activo) y `contract_items.price_id`. Con `supersedes` crea la versión
	 * siguiente y archiva la anterior (un precio referenciado no se edita, spec §2.2). Con catálogo (etapa 3) la fila es una
	 * **copia** del precio de lista (`list_price_id`, nombre del catálogo): el contrato nunca apunta al catálogo directo.
	 * Devuelve el id del precio.
	 */
	private async insertPrice(
		runner: QueryRunner,
		input: {
			contractId: string;
			holdingId: string;
			itemId: string;
			item: ResolvedItem;
			currency: string;
			userId: string;
			supersedes?: { id: string; version: number } | null;
			/** Catálogo a recordar en la copia; por defecto el que eligió el ítem (`price_id`). */
			listPriceId?: string | null;
		}
	): Promise<string> {
		const spec = input.item.price_spec!;
		const [row] = (await runner.query(
			`INSERT INTO prices (
				holding_id, owner, product_id, contract_id, name, currency, model, quantity_type, billable_metric_id,
				unit_amount, tiers, package_size, package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount,
				status, version, supersedes_price_id, created_by, updated_by, published_at, invoice_line_mode, charge_flat_when_free, list_price_id
			) VALUES (
				$1, 'contract', $2, $3, $4, $5, $6, $7, $8,
				$9, $10::jsonb, $11, $12, $13, $14, $15, $16,
				'active', $17, $18, $19, $19, now(), $20, $21, $22
			) RETURNING id`,
			[
				input.holdingId,
				input.item.dto.product_id,
				input.contractId,
				input.item.price_name ?? input.item.product_name,
				input.currency,
				spec.model,
				spec.quantity_type,
				spec.billable_metric_id ?? null,
				spec.unit_amount ?? null,
				spec.tiers ? JSON.stringify(spec.tiers) : null,
				spec.package_size ?? null,
				spec.package_amount ?? null,
				spec.seat_minimum_quantity ?? 0,
				spec.free_units ?? 0,
				spec.minimum_amount ?? null,
				spec.cap_amount ?? null,
				input.supersedes ? input.supersedes.version + 1 : 1,
				input.supersedes?.id ?? null,
				input.userId,
				spec.invoice_line_mode ?? DEFAULT_INVOICE_LINE_MODE,
				spec.charge_flat_when_free === true,
				input.listPriceId === undefined ? input.item.list_price_id : input.listPriceId,
			]
		)) as Row[];
		const priceId = String(row.id);

		await runner.query(`UPDATE contract_items SET price_id = $3 WHERE id = $1 AND holding_id = $2`, [input.itemId, input.holdingId, priceId]);
		if (input.supersedes) await this.archivePrices(runner, [input.supersedes.id], input.holdingId, input.userId);

		return priceId;
	}

	/** Pricing v2: archiva precios inline que dejaron de estar referenciados (versión reemplazada, ítem sin precio o quitado). */
	private async archivePrices(runner: QueryRunner, priceIds: string[], holdingId: string, userId: string): Promise<void> {
		if (!priceIds.length) return;
		await runner.query(
			`UPDATE prices SET status = 'archived', archived_at = now(), updated_at = now(), updated_by = $3
			WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND owner = 'contract' AND status <> 'archived'`,
			[priceIds, holdingId, userId]
		);
	}

	/**
	 * UPDATE de un ítem existente del borrador con los valores del formulario, todo explícito (costura): fin, precios derivados
	 * y la categoría recalculada (`itemCategoriaSql`, con el cliente y el producto ya guardados: cambiar cualquiera de los dos
	 * en el borrador la actualiza); `contracts.term` lo refresca `update` al final con `syncContractTerm`.
	 */
	private async updateItem(
		runner: QueryRunner,
		itemId: string,
		contractId: string,
		holdingId: string,
		item: ResolvedItem,
		quoteItem: Row | undefined,
		bookingDate: string | null
	): Promise<void> {
		await runner.query(
			`UPDATE contract_items SET
				product_id = $4, product_name = $5, account = $6, item_type = $7, unit_of_measure = $8,
				quantity = $9, unit_price = $10, annual_unit_price = $11, price_entry_mode = $12, discount_type = $13, discount_value = $14,
				price = $15, final_price = $16, currency = $17, billing_frequency = $18, billing_method = $19, start_date = $20, end_date = $21,
				term_months = $22, is_recurring = $23, quote_item_id = $24, quote_item_number = $25, auto_renew = $26,
				auto_renew_term_months = $27, booking_date = $28, annual_price = $29, monthly_price = $30, billing_period_price = $31,
				categoria = ${itemCategoriaSql(2, 4)}
			WHERE id = $1 AND contract_id = $2 AND holding_id = $3`,
			[itemId, contractId, holdingId, ...ContractDraftsService.itemValues(item, quoteItem, bookingDate)]
		);
	}

	private async insertFxRates(runner: QueryRunner, contractId: string, holdingId: string, fx: ResolvedFx, userId: string, notes: string) {
		for (const rate of [...fx.invoice_rates, ...fx.company_rates, ...fx.item_rates]) {
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
					notes,
					userId,
				]
			);
		}
	}

	// ---------------------------------------------------------------- editar borrador (F2 del encabezado: formulario completo)

	/** Encabezado del borrador, bloqueado si `lock`. 404 si no es del holding o está borrado. */
	private async loadDraftHeader(db: Queryable, contractId: string, holdingId: string, lock = false): Promise<Row> {
		const [row] = (await db.query(
			`SELECT c.id, c.contract_number, c.status, c.created_at, c.client_id, c.client_entity_id, c.company_id, c.quote_id,
				c.contract_currency, c.invoice_currency, c.fx_invoice_policy, c.fx_company_policy, c.payment_terms, c.document_type,
				c.tax_document_type_id, c.billing_anchor_day, c.group_invoices_by_period, c.auto_send_to_odoo, c.auto_invoice,
				c.booking_date::text AS booking_date, c.salesforce_opportunity_id, c.notes, c.invoice_terms_and_conditions, c.custom_fields,
				c.total_value, c.requires_multicompany_billing, c.requires_multicurrency_billing, c.requires_references_for_billing,
				(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id) AS invoices_count
			FROM contracts c
			WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL
			${lock ? 'FOR UPDATE OF c' : ''}`,
			[contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return row;
	}

	private static assertDraft(contract: Row) {
		if (contract.status !== DRAFT_STATUS) {
			throw new ConflictException(`Solo se edita un contrato en borrador; ${toText(contract.contract_number)} está ${toText(contract.status)}`);
		}
	}

	/**
	 * Tasas fijas guardadas del contrato, en la forma del DTO, por propósito. Multimoneda: la regla "todo el contrato" se lee **por par**
	 * (propósito + moneda de origen); las de facturación devuelven `from_currency` cuando no es la moneda del contrato y las `item`, siempre.
	 */
	private async loadFxRateDtos(db: Queryable, contractId: string, holdingId: string, contractCurrency = '') {
		const rows = (await db.query(
			`SELECT purpose, from_currency, rate, period_start::text AS period_start, period_end::text AS period_end
			FROM contract_fx_period_rates WHERE contract_id = $1 AND holding_id = $2 ORDER BY period_start, created_at`,
			[contractId, holdingId]
		)) as Row[];
		// Rango de los ítems del contrato: una tasa única que lo cubre entero vuelve sin fechas ("Todo el contrato"), como la mandó el formulario.
		const [coverageRow] = (await db.query(
			`SELECT MIN(ci.start_date)::text AS start, MAX(COALESCE(ci.end_date, ci.start_date + INTERVAL '12 months'))::text AS "end"
			FROM contract_items ci WHERE ci.contract_id = $1 AND ci.holding_id = $2`,
			[contractId, holdingId]
		)) as Row[];
		const coverage = { start: toText(coverageRow?.start)?.slice(0, 10) ?? null, end: toText(coverageRow?.end)?.slice(0, 10) ?? null };
		const contract = upperCode(contractCurrency);
		const byPurpose = (purpose: FxRateRow['purpose']): Array<FxRatePeriodDto & { from_currency?: string }> => {
			const own = rows.filter((row) => row.purpose === purpose);

			return own.map((row) => {
				const from = upperCode(row.from_currency);
				const samePair = own.filter((other) => upperCode(other.from_currency) === from);
				const pair = purpose === 'item' || (purpose === 'invoice' && from && from !== contract) ? { from_currency: from } : {};

				return samePair.length === 1 &&
					isWholeContractRate({ period_start: toText(row.period_start), period_end: toText(row.period_end) }, coverage)
					? { ...pair, rate: toNumber(row.rate) }
					: { ...pair, rate: toNumber(row.rate), period_start: String(row.period_start), period_end: String(row.period_end) };
			});
		};

		return {
			invoice: byPurpose('invoice'),
			company: byPurpose('company'),
			item: byPurpose('item') as Array<FxRatePeriodDto & { from_currency: string }>,
		};
	}

	/**
	 * `GET /contracts/:id/form`: el borrador en la forma exacta de `CreateContractDto` (con `items[].id`) para que el
	 * formulario lo edite y lo devuelva con `PUT /contracts/:id`. 409 si no es borrador.
	 */
	async form(idOrNumber: string, holdingId: string) {
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const contract = await this.loadDraftHeader(this.dataSource, resolved.id, holdingId);

		ContractDraftsService.assertDraft(contract);
		const [items, fx] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT ci.id, ci.quote_item_id, ci.product_id, ci.product_name, ci.account, ci.item_type, ci.unit_of_measure, ci.quantity,
					ci.unit_price, ci.annual_unit_price, ci.price_entry_mode, ci.discount_value, ci.billing_frequency, ci.billing_method,
					ci.start_date::text AS start_date, ci.term_months, ci.is_recurring, ci.auto_renew, ci.auto_renew_term_months,
					ci.booking_date::text AS booking_date, ci.currency, ${PRICE_COLUMNS}
				FROM contract_items ci
				LEFT JOIN prices p ON p.id = ci.price_id
				WHERE ci.contract_id = $1 AND ci.holding_id = $2
				ORDER BY ci.start_date NULLS LAST, ci.product_name, ci.id`,
				[contract.id, holdingId]
			),
			this.loadFxRateDtos(this.dataSource, String(contract.id), holdingId, toText(contract.contract_currency) ?? ''),
		]);
		const contractCurrency = toText(contract.contract_currency) ?? '';
		const invoiceCurrency = toText(contract.invoice_currency) ?? contractCurrency;
		const optional = <T>(key: string, value: T | null | undefined): Record<string, T> =>
			value === null || value === undefined ? {} : ({ [key]: value } as Record<string, T>);
		const form: UpdateContractDto = {
			client_id: String(contract.client_id),
			client_entity_id: String(contract.client_entity_id),
			company_id: String(contract.company_id),
			contract_number: toText(contract.contract_number) ?? undefined,
			contract_currency: contractCurrency,
			invoice_currency: invoiceCurrency,
			// Multimoneda: con pares que convierten aunque factura = contrato (ítems en otra moneda), la política también se devuelve.
			...(invoiceCurrency !== contractCurrency ||
			(contract.requires_multicurrency_billing === true &&
				items.some((row) => (upperCode(row.currency) || contractCurrency) !== invoiceCurrency))
				? { fx_invoice_policy: toText(contract.fx_invoice_policy) === 'fixed' ? 'fixed' : 'spot' }
				: {}),
			...(fx.invoice.length ? { fx_invoice_rates: fx.invoice } : {}),
			...(fx.item.length ? { fx_item_rates: fx.item } : {}),
			fx_company_policy: toText(contract.fx_company_policy) === 'fixed_period' ? 'fixed_period' : 'company_default',
			...(fx.company.length ? { fx_company_rates: fx.company } : {}),
			...optional('payment_terms', cleanPaymentTerms(contract.payment_terms) as UpdateContractDto['payment_terms']),
			...optional('tax_document_type_id', toText(contract.tax_document_type_id)),
			...optional('document_type', toText(contract.document_type) as ContractDocumentType | null),
			// NULL = día de ciclo automático (el editor muestra "Automático"); nunca el día derivado.
			billing_anchor_day:
				contract.billing_anchor_day === null || contract.billing_anchor_day === undefined ? null : toNumber(contract.billing_anchor_day),
			group_invoices_by_period: contract.group_invoices_by_period !== false,
			auto_send_to_odoo: contract.auto_send_to_odoo === true,
			auto_invoice: contract.auto_invoice === true,
			...optional('booking_date', toText(contract.booking_date)),
			...optional('quote_id', toText(contract.quote_id)),
			...optional('salesforce_opportunity_id', toText(contract.salesforce_opportunity_id)),
			...optional('notes', toText(contract.notes)),
			...optional('invoice_terms_and_conditions', toText(contract.invoice_terms_and_conditions)),
			custom_fields: (contract.custom_fields as Record<string, unknown> | null) ?? {},
			requires_multicompany_billing: contract.requires_multicompany_billing === true,
			requires_multicurrency_billing: contract.requires_multicurrency_billing === true,
			requires_references_for_billing: contract.requires_references_for_billing === true,
			items: items.map((row): UpdateContractItemDto => {
				const annual = row.price_entry_mode === 'annual';
				const price = priceSpecFromRow(row);

				return {
					id: String(row.id),
					key: String(row.id),
					...optional('quote_item_id', toText(row.quote_item_id)),
					product_id: String(row.product_id),
					// Multimoneda: moneda del ítem (la del contrato en contratos sin multimoneda).
					currency: upperCode(row.currency) || contractCurrency,
					...optional('product_name', toText(row.product_name)),
					...optional('account', toText(row.account)),
					item_type: toText(row.item_type) ?? '',
					...optional('unit_of_measure', toText(row.unit_of_measure)),
					quantity: toNumber(row.quantity),
					...(annual
						? { annual_unit_price: toNumber(row.annual_unit_price), price_entry_mode: 'annual' as const }
						: { unit_price: toNumber(row.unit_price) }),
					...(price ? { price } : {}),
					...optional('list_price_id', toText(row.price_list_price_id)),
					discount_value: toNumber(row.discount_value),
					billing_frequency: (toText(row.billing_frequency) ?? 'Mensual') as UpdateContractItemDto['billing_frequency'],
					billing_method: (toText(row.billing_method) ?? 'Anticipado') as UpdateContractItemDto['billing_method'],
					start_date: toText(row.start_date) ?? '',
					// Sin término (S1-12): `null`, y el formulario lo muestra como "Sin término (indefinido)".
					term_months: row.term_months === null || row.term_months === undefined ? null : toNumber(row.term_months),
					is_recurring: row.is_recurring !== false,
					auto_renew: row.auto_renew === true,
					...optional(
						'auto_renew_term_months',
						row.auto_renew_term_months === null || row.auto_renew_term_months === undefined ? null : toNumber(row.auto_renew_term_months)
					),
					...optional('booking_date', toText(row.booking_date)),
				};
			}),
		};

		return {
			id: String(contract.id),
			contract_number: toText(contract.contract_number),
			status: toText(contract.status),
			created_at: contract.created_at instanceof Date ? contract.created_at.toISOString() : toText(contract.created_at),
			form,
		};
	}

	/**
	 * `GET /contracts/:id/invoices/preview`: las facturas que generaría el borrador guardado, calculadas al vuelo con el
	 * mismo motor que `POST /contracts/preview` (modelos de precio, tipo de cambio y advertencias). No escribe nada: v2 no
	 * guarda `contract_invoices` para borradores. 409 `{ code: 'not_draft' }` si el contrato no está En revisión.
	 */
	async invoicePreview(idOrNumber: string, holdingId: string) {
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const contract = await this.loadDraftHeader(this.dataSource, resolved.id, holdingId);

		if (contract.status !== DRAFT_STATUS) {
			throw new ConflictException({
				message: `La vista previa de facturas es solo para borradores; ${toText(contract.contract_number)} está ${toText(contract.status)}`,
				code: 'not_draft',
			});
		}
		const { form } = await this.form(String(contract.id), holdingId);
		// Plantilla de glosa del contrato y consumos registrados de sus ítems: la vista previa = lo que generaría la activación.
		const [[template], consumptionRows] = await Promise.all([
			this.dataSource.query<Row[]>(`SELECT invoice_description_template FROM contracts WHERE id = $1 AND holding_id = $2`, [
				contract.id,
				holdingId,
			]),
			this.dataSource.query<Row[]>(
				`SELECT e.contract_item_id, e.period_start::text AS period_start, e.quantity, e.amount_override, e.apply_item_discount, e.is_estimated
				FROM consumption_entries e JOIN contract_items ci ON ci.id = e.contract_item_id
				WHERE ci.contract_id = $1 AND e.holding_id = $2`,
				[contract.id, holdingId]
			),
		]);
		const consumption = new Map<string, ConsumptionInput[]>();

		for (const row of consumptionRows ?? []) {
			const key = String(row.contract_item_id);

			consumption.set(key, [
				...(consumption.get(key) ?? []),
				{
					period_start: String(row.period_start).slice(0, 10),
					quantity: toNumber(row.quantity),
					amount_override: row.amount_override === null || row.amount_override === undefined ? null : toNumber(row.amount_override),
					apply_item_discount: row.apply_item_discount !== false,
					is_estimated: row.is_estimated === true,
				},
			]);
		}

		return await this.preview(form, holdingId, {
			description_template: parseStoredTemplate(template?.invoice_description_template),
			contract_number: toText(contract.contract_number),
			consumption,
		});
	}

	/** Tasas antes/después del PUT (propósito, tasa, período; la de todo el contrato sin fechas); `changed` si difieren. */
	static fxRatesDiff(beforeRows: Row[], afterRows: FxRateRow[]) {
		const view = (row: { purpose: unknown; from_currency?: unknown; rate: unknown; period_start: unknown; period_end: unknown }) => {
			const period = { period_start: toText(row.period_start)?.slice(0, 10) ?? null, period_end: toText(row.period_end)?.slice(0, 10) ?? null };

			// Multimoneda: el par (moneda de origen) distingue las tasas de un mismo propósito.
			return {
				purpose: toText(row.purpose),
				...(row.from_currency ? { from_currency: upperCode(row.from_currency) } : {}),
				rate: toNumber(row.rate),
				...period,
			};
		};
		const key = (rows: Array<ReturnType<typeof view>>) =>
			JSON.stringify(
				[...rows].sort((a, b) =>
					`${a.purpose}|${a.from_currency ?? ''}|${a.period_start}`.localeCompare(`${b.purpose}|${b.from_currency ?? ''}|${b.period_start}`)
				)
			);
		const before = beforeRows.map(view);
		const after = afterRows.map(view);

		return { changed: key(before) !== key(after), before, after };
	}

	/** Ítems antes/después del PUT con los campos que mueven facturas (solo los que cambiaron, más los nuevos y los quitados). */
	static itemsDiff(beforeRows: Row[], items: ResolvedItem[], insertedIds: string[]) {
		const view = (row: Row) => ({
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			account: toText(row.account),
			quantity: toNumber(row.quantity),
			unit_price: round2(toNumber(row.unit_price) * 1e4) / 1e4,
			discount_value: toNumber(row.discount_value),
			billing_frequency: toText(row.billing_frequency),
			billing_method: toText(row.billing_method),
			start_date: toText(row.start_date)?.slice(0, 10) ?? null,
			term_months: row.term_months === null || row.term_months === undefined ? null : toNumber(row.term_months),
			is_recurring: row.is_recurring !== false,
			...(row.currency ? { currency: upperCode(row.currency) } : {}),
		});
		const before = new Map(beforeRows.map((row) => [String(row.id), view(row)]));
		const changes: Array<{ item_id: string | null; before: ReturnType<typeof view> | null; after: ReturnType<typeof view> | null }> = [];
		let newIndex = 0;

		for (const item of items) {
			const id = (item.dto as UpdateContractItemDto).id ?? null;
			const after = view({
				...(item.dto as unknown as Row),
				product_name: item.product_name,
				unit_price: item.unit_price,
				term_months: item.dto.term_months ?? null,
				is_recurring: item.is_recurring,
				currency: item.currency,
			});
			const previous = id ? before.get(id) : undefined;

			if (!id) changes.push({ item_id: insertedIds[newIndex++] ?? null, before: null, after });
			else if (previous && JSON.stringify(previous) !== JSON.stringify(after)) changes.push({ item_id: id, before: previous, after });
			if (id) before.delete(id);
		}
		for (const [id, previous] of before) changes.push({ item_id: id, before: previous, after: null });

		return changes;
	}

	/** Encabezado guardado, normalizado para compararlo con el nuevo (fechas como texto, números como número). */
	private static headerSnapshot(row: Row): Record<(typeof DRAFT_HEADER_FIELDS)[number], unknown> {
		return {
			client_id: toText(row.client_id),
			client_entity_id: toText(row.client_entity_id),
			company_id: toText(row.company_id),
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			fx_invoice_policy: toText(row.fx_invoice_policy),
			fx_company_policy: toText(row.fx_company_policy),
			payment_terms: cleanPaymentTerms(row.payment_terms),
			document_type: toText(row.document_type),
			tax_document_type_id: toText(row.tax_document_type_id),
			billing_anchor_day: row.billing_anchor_day === null || row.billing_anchor_day === undefined ? null : toNumber(row.billing_anchor_day),
			group_invoices_by_period: row.group_invoices_by_period !== false,
			auto_send_to_odoo: row.auto_send_to_odoo === true,
			auto_invoice: row.auto_invoice === true,
			booking_date: toText(row.booking_date),
			salesforce_opportunity_id: toText(row.salesforce_opportunity_id),
			notes: toText(row.notes),
			invoice_terms_and_conditions: toText(row.invoice_terms_and_conditions),
			custom_fields: (row.custom_fields as Record<string, unknown> | null) ?? {},
			requires_multicompany_billing: row.requires_multicompany_billing === true,
			requires_multicurrency_billing: row.requires_multicurrency_billing === true,
			requires_references_for_billing: row.requires_references_for_billing === true,
			total_value: toNumber(row.total_value),
		};
	}

	/** JSON con claves ordenadas: `jsonb` devuelve las claves en otro orden que el objeto que se escribió. */
	private static canonical(value: unknown): string {
		const sort = (input: unknown): unknown => {
			if (Array.isArray(input)) return input.map(sort);
			if (input && typeof input === 'object') {
				return Object.fromEntries(
					Object.keys(input as Record<string, unknown>)
						.sort()
						.map((key) => [key, sort((input as Record<string, unknown>)[key])])
				);
			}

			return input ?? null;
		};

		return JSON.stringify(sort(value));
	}

	/**
	 * `PUT /contracts/:id` (solo borradores En revisión sin facturas): reemplaza encabezado, ítems y tasas fijas en **una
	 * transacción** con las mismas validaciones que crear (contexto del holding, reglas FX y UF, cotización). Los ítems se
	 * emparejan por `items[].id`: con id se actualizan, sin id se crean y los que no vienen se eliminan (un borrador no tiene
	 * facturas; si un ítem tiene cantidades registradas, 409). Conserva `contract_number`, `quote_id`, `created_at` y las
	 * banderas heredadas de la cotización. Deja el evento `DRAFT_UPDATED` con los campos que cambiaron.
	 */
	async update(idOrNumber: string, dto: UpdateContractDto, holdingId: string, authId: string, now = new Date()) {
		const userId = await this.userId(authId);
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia; los triggers legacy no rellenan nada, la API escribe cada campo.
			await setApiWriter(runner);
			const current = await this.loadDraftHeader(runner, resolved.id, holdingId, true);
			const contractId = String(current.id);
			const contractNumber = toText(current.contract_number);

			ContractDraftsService.assertDraft(current);
			if (toNumber(current.invoices_count) > 0) {
				throw new ConflictException(`El borrador ${contractNumber} ya tiene facturas: no se puede editar como formulario`);
			}
			const fixedErrors: FieldError[] = [];

			if (dto.contract_number && dto.contract_number !== contractNumber) {
				fixedErrors.push({ field: 'contract_number', message: 'El número de contrato no se cambia al editar el borrador' });
			}
			if (dto.quote_id && dto.quote_id !== toText(current.quote_id)) {
				fixedErrors.push({ field: 'quote_id', message: 'La cotización de origen no se cambia al editar el borrador' });
			}
			if (fixedErrors.length) throw validationException(fixedErrors);

			// Multimoneda: sin flag en el body se conserva el guardado. Con multimoneda ya activada, la moneda del contrato no cambia: los
			// ítems y sus tasas ítem → contrato se pactaron contra ella (400 multicurrency_contract_currency_locked).
			if (current.requires_multicurrency_billing === true && upperCode(current.contract_currency) !== upperCode(dto.contract_currency)) {
				throw codedValidationException([
					{
						field: 'contract_currency',
						message: `El contrato es multimoneda: su moneda (${toText(current.contract_currency)}) no se cambia; ajusta la moneda de cada ítem`,
						code: MULTICURRENCY_CODES.multicurrency_contract_currency_locked,
					},
				]);
			}
			const context = {
				...(await this.loadContext(
					runner,
					{ ...dto, requires_multicurrency_billing: dto.requires_multicurrency_billing ?? current.requires_multicurrency_billing === true },
					holdingId
				)),
				multicurrency_default: current.requires_multicurrency_billing === true,
			};
			const items = ContractDraftsService.resolveItems(dto, context.products, context.catalog_prices);
			const defaults = ContractDraftsService.contractDefaults(dto, context, items);
			const existing = (await runner.query(
				`SELECT ci.id, ci.product_id, ci.quote_item_id, ${PRICE_COLUMNS}, p.currency AS price_currency, p.product_id AS price_product_id,
					ci.product_name, ci.account, ci.quantity, ci.unit_price, ci.discount_value, ci.billing_frequency, ci.billing_method,
					ci.start_date::text AS start_date, ci.term_months, ci.is_recurring, ci.currency
				FROM contract_items ci LEFT JOIN prices p ON p.id = ci.price_id
				WHERE ci.contract_id = $1 AND ci.holding_id = $2 ORDER BY ci.id`,
				[contractId, holdingId]
			)) as Row[];
			const fxBefore = (await runner.query(
				`SELECT purpose, from_currency, rate, period_start::text AS period_start, period_end::text AS period_end
				FROM contract_fx_period_rates WHERE contract_id = $1 AND holding_id = $2 ORDER BY purpose, period_start`,
				[contractId, holdingId]
			)) as Row[];
			const existingById = new Map<string, DraftItemRow>(
				existing.map((row) => [
					String(row.id),
					{
						id: String(row.id),
						product_id: toText(row.product_id),
						quote_item_id: toText(row.quote_item_id),
						price_id: toText(row.price_id),
						price: priceSpecFromRow(row),
						price_version: toNumber(row.price_version) || 1,
						list_price_id: toText(row.price_list_price_id),
						price_currency: toText(row.price_currency),
						price_product_id: toText(row.price_product_id),
					},
				])
			);
			const itemErrors: FieldError[] = [];
			const seenIds = new Set<string>();

			dto.items.forEach((item, index) => {
				if (!item.id) return;
				if (!existingById.has(item.id)) itemErrors.push({ field: `items.${index}.id`, message: 'El ítem no pertenece a este borrador' });
				else if (seenIds.has(item.id)) itemErrors.push({ field: `items.${index}.id`, message: 'Ítem repetido' });
				seenIds.add(item.id);
			});
			if (itemErrors.length) throw validationException(itemErrors);

			const quote = current.quote_id
				? ((
						(await runner.query(`SELECT id, quote_number, booking_date FROM quotes WHERE id = $1 AND holding_id = $2`, [
							current.quote_id,
							holdingId,
						])) as Row[]
					)[0] ?? null)
				: null;
			const quoteItems = await this.quoteItems(runner, dto, quote);
			const toDelete = [...existingById.keys()].filter((id) => !seenIds.has(id));

			if (toDelete.length) {
				const [withQuantities] = (await runner.query(`SELECT COUNT(*) AS count FROM quantities WHERE contract_item_id = ANY($1::uuid[])`, [
					toDelete,
				])) as Row[];

				if (toNumber(withQuantities?.count) > 0) {
					throw new ConflictException('No se pueden quitar ítems que ya tienen cantidades registradas: déjalos en el borrador');
				}
				// Consumos v2 (`consumption_entries`): quitar el ítem borraría lo informado (y su historial de revisiones).
				const [withConsumption] = (await runner.query(
					`SELECT COUNT(*) AS count FROM consumption_entries WHERE contract_item_id = ANY($1::uuid[]) AND holding_id = $2`,
					[toDelete, holdingId]
				)) as Row[];

				if (toNumber(withConsumption?.count) > 0) {
					throw new ConflictException({
						message: 'No se pueden quitar ítems que ya tienen consumo registrado: déjalos en el borrador',
						code: 'item_has_consumption',
					});
				}
			}

			const [settings] = (await runner.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [
				holdingId,
			])) as Row[];
			const systemCurrency = toText(settings?.system_currency) ?? 'USD';
			const totalValue = ContractDraftsService.totalValue(items, dto.contract_currency, defaults.fx);
			const contractEnd = ContractDraftsService.contractEndDate(items);
			// `null` explícito borra la fecha de cierre (se fija al activar); ausente conserva la guardada o la de la cotización.
			const bookingDate =
				dto.booking_date === null ? null : (dto.booking_date ?? toText(current.booking_date) ?? toIsoDate(quote?.booking_date) ?? null);
			// S1-15: las marcas se editan; si el body no las trae, se conservan las guardadas.
			const flags = {
				...ContractDraftsService.billingFlags(dto, {
					requires_multicompany: current.requires_multicompany_billing,
					requires_multicurrency: current.requires_multicurrency_billing,
					requires_references_for_billing: current.requires_references_for_billing,
				}),
				requires_multicurrency_billing: defaults.fx.multicurrency,
			};
			const before = ContractDraftsService.headerSnapshot(current);
			const after: typeof before = {
				client_id: context.client.id,
				client_entity_id: context.entity.id,
				company_id: context.company.id,
				contract_currency: dto.contract_currency,
				invoice_currency: defaults.invoice_currency,
				fx_invoice_policy: defaults.fx_invoice_policy,
				fx_company_policy: defaults.fx_company_policy,
				payment_terms: defaults.payment_terms,
				document_type: defaults.document_type,
				tax_document_type_id: defaults.tax_document_type_id,
				billing_anchor_day: defaults.billing_anchor_day,
				group_invoices_by_period: defaults.group_invoices_by_period,
				auto_send_to_odoo: dto.auto_send_to_odoo ?? false,
				auto_invoice: dto.auto_invoice ?? false,
				booking_date: bookingDate,
				salesforce_opportunity_id:
					dto.salesforce_opportunity_id === null || dto.salesforce_opportunity_id === ''
						? null
						: (dto.salesforce_opportunity_id ?? toText(current.salesforce_opportunity_id)),
				notes: dto.notes ?? null,
				invoice_terms_and_conditions: dto.invoice_terms_and_conditions ?? null,
				custom_fields: dto.custom_fields ?? {},
				...flags,
				total_value: totalValue,
			};
			const changedFields = DRAFT_HEADER_FIELDS.filter(
				(field) => ContractDraftsService.canonical(before[field]) !== ContractDraftsService.canonical(after[field])
			);

			// Cambio de moneda: `validate_contract_currency_consistency` (contrato) y `validate_contract_item_currency_consistency`
			// (ítems) exigen que ambos lados coincidan en cada sentencia; entre el UPDATE del encabezado y el de los ítems no lo
			// hacen. Se apagan solo en esta transacción (GUC de la casa) y al final todos los ítems quedan en la moneda nueva.
			// Multimoneda: también al prender/apagar el flag (los ítems se reescriben después del encabezado; apagarlo con ítems que quedan en otra
			// moneda ya se rechazó con 400 en `loadContext`).
			if (
				before.contract_currency !== dto.contract_currency ||
				before.requires_multicurrency_billing !== flags.requires_multicurrency_billing
			) {
				await runner.query(`SELECT set_config('sapira.skip_currency_validation', 'on', true)`);
			}

			await runner.query(
				`UPDATE contracts SET
					client_id = $3, client_entity_id = $4, company_id = $5, total_value = $6, legal_client_name = $7, client_name_commercial = $8,
					notes = $9, booking_date = $10, contract_end_date = $11, contract_currency = $12, system_currency = $13, fx_rate_to_system = $14,
					total_value_system_currency = $15, company_currency = $16, fx_company_policy = $17, fx_invoice_policy = $18, invoice_currency = $19,
					custom_fields = $20::jsonb, auto_invoice = $21, auto_send_to_odoo = $22, group_invoices_by_period = $23, salesforce_opportunity_id = $24,
					invoice_terms_and_conditions = $25, billing_anchor_day = $26, payment_terms = $27::jsonb, document_type = $28, tax_document_type_id = $29,
					fx_invoice_confirmed_at = CASE WHEN $30::boolean THEN COALESCE(fx_invoice_confirmed_at, now()) END,
					fx_company_confirmed_at = CASE WHEN $31::boolean THEN COALESCE(fx_company_confirmed_at, now()) END,
					requires_multicompany_billing = $32, requires_multicurrency_billing = $33, requires_references_for_billing = $34
				WHERE id = $1 AND holding_id = $2`,
				[
					contractId,
					holdingId,
					context.client.id,
					context.entity.id,
					context.company.id,
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
					JSON.stringify(dto.custom_fields ?? {}),
					dto.auto_invoice ?? false,
					dto.auto_send_to_odoo ?? false,
					defaults.group_invoices_by_period,
					after.salesforce_opportunity_id,
					dto.invoice_terms_and_conditions ?? null,
					defaults.billing_anchor_day,
					defaults.payment_terms ? JSON.stringify(defaults.payment_terms) : null,
					defaults.document_type,
					defaults.tax_document_type_id,
					defaults.fx.fx_invoice_confirmed,
					defaults.fx.fx_company_confirmed,
					flags.requires_multicompany_billing,
					flags.requires_multicurrency_billing,
					flags.requires_references_for_billing,
				]
			);

			const updated: string[] = [];
			const inserted: string[] = [];
			const priceChanges: Array<{ item_id: string; from: string | null; to: string | null }> = [];

			for (const item of items) {
				const quoteItem = item.dto.quote_item_id ? quoteItems.get(item.dto.quote_item_id) : undefined;
				const itemId = (item.dto as UpdateContractItemDto).id;

				if (itemId) {
					await this.updateItem(runner, itemId, contractId, holdingId, item, quoteItem, bookingDate);
					updated.push(itemId);
					// Pricing v2: precio nuevo, distinto o de otro catálogo → versión siguiente (la anterior se archiva); sin precio → standard fijo.
					// Editar inline la copia de un catálogo conserva `list_price_id` si el formulario lo devuelve igual (etapa 3).
					const previous = existingById.get(itemId)!;
					const listPriceId =
						item.list_price_id ??
						(item.dto.list_price_id && item.dto.list_price_id === previous.list_price_id ? previous.list_price_id : null);

					const catalogChanged = Boolean(item.list_price_id) && item.list_price_id !== previous.list_price_id;
					// Misma forma pero otra moneda (cambió la del contrato) u otro producto: la fila de `prices` ya no corresponde → versión nueva.
					const ownerChanged =
						Boolean(previous.price_id) &&
						((previous.price_currency ?? item.currency) !== item.currency ||
							(previous.price_product_id ?? previous.product_id) !== item.dto.product_id);

					if (item.price_spec && (!samePriceSpec(previous.price, item.price_spec) || catalogChanged || ownerChanged)) {
						const priceId = await this.insertPrice(runner, {
							contractId,
							holdingId,
							itemId,
							item,
							currency: item.currency,
							userId,
							supersedes: previous.price_id ? { id: previous.price_id, version: previous.price_version } : null,
							listPriceId,
						});

						priceChanges.push({ item_id: itemId, from: previous.price_id, to: priceId });
					} else if (!item.price_spec && previous.price_id) {
						await runner.query(`UPDATE contract_items SET price_id = NULL WHERE id = $1 AND holding_id = $2`, [itemId, holdingId]);
						await this.archivePrices(runner, [previous.price_id], holdingId, userId);
						priceChanges.push({ item_id: itemId, from: previous.price_id, to: null });
					}
				} else {
					const newItemId = await this.insertItem(runner, contractId, holdingId, item, quoteItem, bookingDate);

					inserted.push(newItemId);
					if (item.price_spec)
						await this.insertPrice(runner, { contractId, holdingId, itemId: newItemId, item, currency: item.currency, userId });
				}
			}
			if (toDelete.length) {
				await runner.query(`DELETE FROM contract_items WHERE contract_id = $1 AND holding_id = $2 AND id = ANY($3::uuid[])`, [
					contractId,
					holdingId,
					toDelete,
				]);
				await this.archivePrices(
					runner,
					toDelete.map((id) => existingById.get(id)?.price_id).filter((id): id is string => Boolean(id)),
					holdingId,
					userId
				);
			}

			// `contracts.term` = mayor plazo de los ítems que quedan (antes `update_contract_term`).
			await syncContractTerm(runner, contractId, holdingId);
			// Tasas fijas: v2 es dueño de las del borrador; se reemplazan por las del formulario (las dos finalidades).
			await runner.query(`DELETE FROM contract_fx_period_rates WHERE contract_id = $1 AND holding_id = $2`, [contractId, holdingId]);
			await this.insertFxRates(runner, contractId, holdingId, defaults.fx, userId, 'Cargada al editar el borrador (v2)');

			const summary = [
				changedFields.length ? `campos: ${changedFields.join(', ')}` : null,
				inserted.length ? `${inserted.length} ítem(s) nuevo(s)` : null,
				updated.length ? `${updated.length} ítem(s) actualizado(s)` : null,
				toDelete.length ? `${toDelete.length} ítem(s) quitado(s)` : null,
				priceChanges.length ? `${priceChanges.length} precio(s) cambiado(s)` : null,
			]
				.filter(Boolean)
				.join('; ');

			await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at,
					effective_date, items_affected, metadata
				) VALUES ($1, $2, 'DRAFT_UPDATED', 'Completed', $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb)`,
				[
					contractId,
					holdingId,
					'Borrador editado',
					`Borrador ${contractNumber ?? ''} editado${summary ? ` (${summary})` : ' sin cambios'}`.replace(/\s+/g, ' '),
					userId,
					todayIso(now),
					JSON.stringify([...updated, ...inserted, ...toDelete]),
					JSON.stringify({
						source: 'api_v2',
						contract_number: contractNumber,
						changed_fields: changedFields,
						before: Object.fromEntries(changedFields.map((field) => [field, before[field]])),
						after: Object.fromEntries(changedFields.map((field) => [field, after[field]])),
						items: { updated, inserted, deleted: toDelete },
						fx_rates: defaults.fx.invoice_rates.length + defaults.fx.company_rates.length + defaults.fx.item_rates.length,
						// Diff (auditoría 01-10): tasas y ítems antes/después, para saber qué cambió sin reconstruirlo.
						fx_rates_diff: ContractDraftsService.fxRatesDiff(fxBefore, [
							...defaults.fx.invoice_rates,
							...defaults.fx.company_rates,
							...defaults.fx.item_rates,
						]),
						items_diff: ContractDraftsService.itemsDiff(existing, items, inserted),
						price_changes: priceChanges,
					}),
				]
			);
			// Pricing v2: el cambio de modelo de precio de un ítem existente deja su propio evento.
			if (priceChanges.length) {
				await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, items_affected, metadata
					) VALUES ($1, $2, 'PRICE_CHANGED', 'Completed', 'Modelo de precio cambiado', $3, $4, now(), $5, $6::jsonb, $7::jsonb)`,
					[
						contractId,
						holdingId,
						`Se cambió el modelo de precio de ${priceChanges.length} ítem(s) del borrador ${contractNumber ?? ''}`.replace(/\s+/g, ' '),
						userId,
						todayIso(now),
						JSON.stringify(priceChanges.map((change) => change.item_id)),
						JSON.stringify({ source: 'api_v2', contract_number: contractNumber, changes: priceChanges }),
					]
				);
			}

			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.contracts.detail(resolved.id, holdingId);
	}

	// ---------------------------------------------------------------- condiciones de factura

	/**
	 * `PATCH /contracts/:id/terms`: cambia `invoice_terms_and_conditions` en borradores y contratos vigentes (Activo,
	 * pausado…); un contrato Cancelado ya no se toca (409). Deja el evento `TERMS_UPDATED` con el antes y el después.
	 *
	 * Alcance: solo el contrato. La API copia las condiciones del contrato **al insertar** cada factura (antes el trigger
	 * `invoices_fill_terms_from_contract`); las facturas Por Emitir que ya existen conservan el texto que tenían
	 * (`pending_invoices_updated: false`).
	 */
	async updateTerms(idOrNumber: string, dto: UpdateContractTermsDto, holdingId: string, authId: string) {
		const userId = await this.userId(authId);
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia; los triggers legacy no rellenan nada, la API escribe cada campo.
			await setApiWriter(runner);
			const [contract] = (await runner.query(
				`SELECT id, contract_number, status, invoice_terms_and_conditions FROM contracts
				WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`,
				[resolved.id, holdingId]
			)) as Row[];

			if (!contract) throw new NotFoundException('Contrato no encontrado');
			const number = toText(contract.contract_number);

			if (contract.status === CONTRACT_CANCELLED_STATUS) {
				throw new ConflictException(`El contrato ${number} está cancelado: sus condiciones de factura ya no se editan`);
			}
			const before = toText(contract.invoice_terms_and_conditions);
			const after =
				dto.invoice_terms_and_conditions === null || dto.invoice_terms_and_conditions.trim() === '' ? null : dto.invoice_terms_and_conditions;

			if (before === after) {
				await runner.commitTransaction();

				return {
					id: String(contract.id),
					contract_number: number,
					invoice_terms_and_conditions: after,
					changed: false,
					pending_invoices_updated: false,
				};
			}

			await runner.query(`UPDATE contracts SET invoice_terms_and_conditions = $3 WHERE id = $1 AND holding_id = $2`, [
				contract.id,
				holdingId,
				after,
			]);
			await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, metadata
				) VALUES ($1, $2, 'TERMS_UPDATED', 'Completed', 'Condiciones de factura actualizadas', $3, $4, now(), CURRENT_DATE, $5::jsonb)`,
				[
					contract.id,
					holdingId,
					after
						? `Se actualizaron las condiciones de factura de ${number ?? ''}`.trim()
						: `Se quitaron las condiciones de factura de ${number ?? ''}`.trim(),
					userId,
					JSON.stringify({ source: 'api_v2', contract_number: number, before, after, pending_invoices_updated: false }),
				]
			);
			await runner.commitTransaction();

			return {
				id: String(contract.id),
				contract_number: number,
				invoice_terms_and_conditions: after,
				changed: true,
				pending_invoices_updated: false,
			};
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
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
			FROM quotes WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`,
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
	private async markQuoteContractCreated(
		runner: QueryRunner,
		quoteId: string,
		holdingId: string,
		contract: { id: string; contract_number: string; userId: string } | null = null
	): Promise<boolean> {
		// Cotizaciones v2 (Q-A1): primero la etapa con `kind = contract_created`; si el holding no la tiene con kind, por nombre como antes.
		const [stage] = (await runner.query(
			`SELECT id, kind FROM quote_stages WHERE holding_id = $1 AND (kind = 'contract_created' OR lower(name) = lower($2))
			ORDER BY (kind = 'contract_created') DESC NULLS LAST, position LIMIT 1`,
			[holdingId, QUOTE_CONTRACT_CREATED_STAGE]
		)) as Row[];

		if (!stage) {
			this.logger.warn(
				`El holding ${holdingId} no tiene la etapa "${QUOTE_CONTRACT_CREATED_STAGE}": la cotización ${quoteId} queda en su etapa`
			);
			if (contract) await this.insertQuoteContractEvent(runner, quoteId, holdingId, contract, null);

			return false;
		}
		// `updated_at` lo pone el trigger `quotes_set_updated_at`; el actor queda en el evento `CONTRACT_CREATED`.
		await runner.query(`UPDATE quotes SET quote_stage_id = $3 WHERE id = $1 AND holding_id = $2`, [quoteId, holdingId, stage.id]);
		if (contract) await this.insertQuoteContractEvent(runner, quoteId, holdingId, contract, String(stage.id));

		return true;
	}

	/** Cotizaciones v2: evento `CONTRACT_CREATED` en el historial de la cotización (`quote_events`), en la misma transacción del contrato. */
	private async insertQuoteContractEvent(
		runner: QueryRunner,
		quoteId: string,
		holdingId: string,
		contract: { id: string; contract_number: string; userId: string },
		toStageId: string | null
	): Promise<void> {
		const [from] = (await runner.query(
			`SELECT q.quote_stage_id, qs.kind FROM quotes q LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id WHERE q.id = $1`,
			[quoteId]
		)) as Row[];

		await runner.query(
			`INSERT INTO quote_events (holding_id, quote_id, type, from_stage_id, to_stage_id, from_kind, to_kind, actor_id, metadata)
			VALUES ($1, $2, 'CONTRACT_CREATED', $3, $4, $5, $6, $7, $8::jsonb)`,
			[
				holdingId,
				quoteId,
				toText(from?.quote_stage_id),
				toStageId,
				toText(from?.kind),
				toStageId ? 'contract_created' : toText(from?.kind),
				contract.userId,
				JSON.stringify({
					source: 'api_v2',
					contract_id: contract.id,
					contract_number: contract.contract_number,
					stage_updated: Boolean(toStageId),
				}),
			]
		);
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
			// Costura `sapira.writer = 'api'`: primera sentencia; los triggers legacy no rellenan nada, la API escribe cada campo.
			await setApiWriter(runner);
			const key = (idOrNumber ?? '').trim();
			const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
			const [contract] = (await runner.query(
				`SELECT c.id, c.contract_number, c.status,
					(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false) AS invoices_count
				FROM contracts c
				WHERE ${byId ? 'c.id = $1::uuid' : 'c.contract_number = $1'} AND c.holding_id = $2 AND c.deleted_at IS NULL
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
			// Costura `sapira.writer = 'api'`: primera sentencia; los triggers legacy no rellenan nada, la API escribe cada campo.
			await setApiWriter(runner);
			const rows = (await runner.query(
				`SELECT c.id, c.contract_number, c.status,
					(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false) AS invoices_count
				FROM contracts c
				WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND c.deleted_at IS NULL
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
