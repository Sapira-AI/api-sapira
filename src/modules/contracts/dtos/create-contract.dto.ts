import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsNotIn,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { CONTRACT_DOCUMENT_TYPES, type ContractDocumentType } from '@/databases/postgresql/entities/contratos/contract.entity';
import { PaymentTermsDto } from '@/modules/clients/dtos/client-directory.dto';

import { BILLING_FREQUENCIES, BILLING_METHODS, type BillingFrequency, type BillingMethod } from '../billing-engine';
import {
	INVOICE_LINE_MODES,
	type InvoiceLineMode,
	PRICE_MODELS,
	PRICE_QUANTITY_TYPES,
	type PriceModel,
	type PriceQuantityType,
} from '../pricing-engine';

import { CreateScheduledChangeDto } from './contract-scheduled-changes.dto';

export const FX_INVOICE_POLICIES = ['spot', 'fixed'] as const;
/**
 * Cómo devenga el contrato en la moneda de la compañía (solo si difiere de la del contrato): `company_default` copia la
 * política de la compañía (`companies.fx_company_policy`, hoy `monthly_avg`); `fixed_period` usa tasas propias del
 * contrato (`fx_company_rates`).
 */
export const FX_COMPANY_POLICIES = ['company_default', 'fixed_period'] as const;
/** Máximo de tasas por período en cada lista. */
export const FX_RATES_MAX = 120;
/** La UF (CLF) es moneda de contrato, nunca de facturación: un contrato en UF se factura en CLP (u otra moneda local). */
export const UF_CURRENCY = 'CLF';
export const UF_NOT_INVOICEABLE_MESSAGE = 'La UF no se factura: elige la moneda en que se emite (por ejemplo, CLP)';
export const PRICE_ENTRY_MODES = ['monthly', 'annual'] as const;
/** Día de ciclo del ítem (spec modificaciones §9.3.9): el del contrato o el propio (día de su inicio, `contract_items.billing_anchor_day`). */
export const BILLING_CYCLES = ['contract', 'own'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY = /^[A-Z]{2,4}$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Tasa fija por período, con la regla única "1 [moneda del contrato] = rate [otra moneda]" (se multiplica). Sin fechas,
 * cubre todo el contrato (se guarda como "todo el contrato" y se resuelve sobre su horizonte real al generar y activar).
 */
export class FxRatePeriodDto {
	@ApiProperty({ description: '1 [moneda del contrato] = rate [moneda de factura o de la compañía]', example: 950 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la tasa (hasta 6 decimales)' })
	@Min(0.000001, { message: 'La tasa debe ser mayor que 0' })
	@Max(999999999, { message: 'Tasa fuera de rango' })
	rate!: number;

	@ApiPropertyOptional({
		example: '2026-10-01',
		description:
			'Sin period_start ni period_end = tasa para todo el contrato (no convive con tasas por período). Solo fin: inicio = primer inicio de los ítems',
	})
	@Matches(ISO_DATE, { message: 'Fecha de inicio de la tasa inválida' })
	@IsOptional()
	period_start?: string;

	@ApiPropertyOptional({
		example: '2027-09-30',
		description: 'Default (con inicio): último fin de los ítems; un ítem sin término cubre su horizonte de 12 períodos',
	})
	@Matches(ISO_DATE, { message: 'Fecha de fin de la tasa inválida' })
	@IsOptional()
	period_end?: string;
}

/**
 * Tasa de facturación por par (multimoneda, `spec-multimoneda-contrato.md` §6): "1 [from_currency] = rate [moneda de factura]". Sin
 * `from_currency` = la moneda del contrato (como hasta hoy); en un contrato multimoneda, una por moneda de ítem ≠ moneda de factura.
 */
export class FxPairRateDto extends FxRatePeriodDto {
	@ApiPropertyOptional({ example: 'USD', description: 'Moneda de origen del par (la del ítem). Default: la moneda del contrato' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda de origen de la tasa inválida' })
	@IsOptional()
	from_currency?: string;
}

/**
 * Tasa fija pactada ítem → contrato (multimoneda, `purpose = 'item'`): "1 [from_currency] = rate [moneda del contrato]". Convierte MRR, TCV
 * y devengo de los ítems en otra moneda. Obligatoria una por moneda de ítem ≠ moneda del contrato; sin fechas = todo el contrato.
 */
export class FxItemRateDto extends FxRatePeriodDto {
	@ApiProperty({ example: 'USD', description: 'Moneda del ítem (≠ moneda del contrato)' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Indica la moneda del ítem de la tasa' })
	from_currency!: string;
}

/** Tramo de un precio `graduated`/`volume` (Pricing v2 §3.1): `from` de cada tramo = `to` anterior + 1; el último `to` es null (∞). */
export class PriceTierDto {
	@ApiProperty({ description: 'Primera unidad del tramo (el primero empieza en 1)', example: 1 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe desde qué unidad va el tramo' })
	@Min(1, { message: 'El tramo empieza en una unidad de 1 o más' })
	from!: number;

	@ApiPropertyOptional({ description: 'Última unidad del tramo; null o ausente = infinito (solo el último)', nullable: true, example: 500 })
	@ValidateIf((_tier: PriceTierDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe hasta qué unidad va el tramo' })
	@Min(1, { message: 'El fin del tramo va de 1 en adelante' })
	to?: number | null;

	@ApiProperty({ description: 'Precio por unidad dentro del tramo', example: 0.08 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario del tramo' })
	@Min(0, { message: 'El precio unitario del tramo no puede ser negativo' })
	per_unit_amount!: number;

	@ApiPropertyOptional({ description: 'Cargo fijo del tramo (una vez por período si el tramo tiene unidades)', default: 0 })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Cargo fijo del tramo inválido' })
	@Min(0, { message: 'El cargo fijo del tramo no puede ser negativo' })
	@IsOptional()
	flat_amount?: number;
}

/**
 * Modelo de precio inline del ítem (Pricing v2 etapa 1, `docs/v2-rediseno/spec-pricing-v2.md` §2.2 y §4.1). Se guarda como fila
 * de `prices` con `owner = contract` y el ítem la apunta con `price_id`. La coherencia entre campos (tramos contiguos,
 * métrica si es medido, tope ≥ mínimo) la valida `validatePriceSpec` con `errors[{ field: items.N.price.<campo> }]`.
 */
export class PriceSpecDto {
	@ApiProperty({ enum: PRICE_MODELS, description: 'standard (por unidad), graduated (por tramos), volume, package o seat' })
	@IsIn(PRICE_MODELS, { message: 'Elige el modelo de precio: fijo, por tramos, volumen, paquete o asiento' })
	model!: PriceModel;

	@ApiProperty({ enum: PRICE_QUANTITY_TYPES, description: 'fixed = la cantidad del ítem; metered = la métrica facturable por período' })
	@IsIn(PRICE_QUANTITY_TYPES, { message: 'Indica si la cantidad es fija o medida' })
	quantity_type!: PriceQuantityType;

	@ApiPropertyOptional({ description: 'Métrica facturable del holding (obligatoria si quantity_type = metered)' })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsUUID(undefined, { message: 'Métrica facturable inválida' })
	billable_metric_id?: string | null;

	@ApiPropertyOptional({ description: 'standard y seat: precio por unidad del período de la línea (no mensual)' })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio por unidad del período' })
	@Min(0, { message: 'El precio por unidad no puede ser negativo' })
	unit_amount?: number | null;

	@ApiPropertyOptional({ type: [PriceTierDto], description: 'graduated/volume: tramos contiguos desde 1, el último hasta infinito' })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsArray({ message: 'Agrega al menos un tramo' })
	@ArrayMaxSize(50, { message: 'Máximo 50 tramos' })
	@ValidateNested({ each: true })
	@Type(() => PriceTierDto)
	tiers?: PriceTierDto[] | null;

	@ApiPropertyOptional({ description: 'package: unidades por bloque' })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe cuántas unidades tiene el paquete' })
	@Min(0.000001, { message: 'El paquete debe tener más de 0 unidades' })
	package_size?: number | null;

	@ApiPropertyOptional({ description: 'package: precio del bloque' })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el precio del paquete' })
	@Min(0.01, { message: 'El precio del paquete debe ser mayor que 0' })
	package_amount?: number | null;

	@ApiPropertyOptional({ description: 'seat: asientos mínimos cobrados por período', default: 0 })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Mínimo de asientos inválido' })
	@Min(0, { message: 'El mínimo de asientos no puede ser negativo' })
	seat_minimum_quantity?: number | null;

	@ApiPropertyOptional({ description: 'Unidades gratis por período (ocupan las primeras posiciones del primer tramo)', default: 0 })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Unidades gratis inválidas' })
	@Min(0, { message: 'Las unidades gratis no pueden ser negativas' })
	free_units?: number | null;

	@ApiPropertyOptional({ description: 'Mínimo comprometido por período con true-up; null = sin mínimo', nullable: true })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Mínimo comprometido inválido' })
	@Min(0, { message: 'El mínimo comprometido no puede ser negativo' })
	minimum_amount?: number | null;

	@ApiPropertyOptional({ description: 'Tope máximo por período; null = sin tope (debe ser ≥ mínimo)', nullable: true })
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Tope máximo inválido' })
	@Min(0, { message: 'El tope máximo no puede ser negativo' })
	cap_amount?: number | null;

	@ApiPropertyOptional({
		enum: INVOICE_LINE_MODES,
		default: 'single',
		description:
			'Presentación en la factura (spec §3.8): single = una línea (cantidad del período × unitario efectivo) con el detalle por tramo en la glosa; per_tier = una línea por tramo/paquete/asiento más una por ajuste (descuento, mínimo, tope)',
	})
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsIn(INVOICE_LINE_MODES, { message: 'Elige cómo se presenta en la factura: una línea (single) o una por tramo (per_tier)' })
	invoice_line_mode?: InvoiceLineMode | null;

	@ApiPropertyOptional({
		default: false,
		description: 'graduated/volume: cobrar el cargo fijo del tramo aunque todo el consumo del período caiga en unidades gratis (spec §3.5)',
	})
	@ValidateIf((_price: PriceSpecDto, value: unknown) => value !== null && value !== undefined)
	@IsBoolean({ message: 'Indica con verdadero o falso si el cargo fijo se cobra con todo el consumo gratis' })
	charge_flat_when_free?: boolean | null;
}

/** `true` si el ítem trae un precio distinto del "standard fijo" de hoy (el unitario mensual deja de ser obligatorio). */
export const hasPricingModel = (item: { price?: PriceSpecDto | null }) =>
	Boolean(item.price) && !(item.price!.model === 'standard' && item.price!.quantity_type === 'fixed');
/** El ítem trae un modelo de precio: inline distinto de standard fijo, o un precio de catálogo (`price_id`, etapa 3). */
export const usesPricingModel = (item: { price?: PriceSpecDto | null; price_id?: string | null }) => hasPricingModel(item) || Boolean(item.price_id);

/** Ítem de `CreateContractDto`. Límites de texto = los de `contract_items` (varchar 64/32/128). */
export class CreateContractItemDto {
	@ApiPropertyOptional({ description: 'Identificador del ítem en el formulario; vuelve como `item_key` en la vista previa' })
	@IsString({ message: 'Ítem inválido' })
	@MinLength(1, { message: 'Ítem inválido' })
	@MaxLength(64, { message: 'Ítem inválido' })
	@IsOptional()
	key?: string;

	@ApiPropertyOptional({ description: 'Línea de la cotización de origen' })
	@IsUUID(undefined, { message: 'Ítem de cotización inválido' })
	@IsOptional()
	quote_item_id?: string;

	@ApiProperty({ description: 'Producto del catálogo (obligatorio, S1-12)' })
	@IsUUID(undefined, { message: 'Elige un producto' })
	product_id!: string;

	@ApiPropertyOptional({
		example: 'USD',
		description:
			'Multimoneda: moneda del ítem (precio, consumos). Default: la del contrato. Distinta solo con requires_multicurrency_billing (400 item_currency_requires_multicurrency); UF permitida',
	})
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda del ítem inválida' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ description: 'Nombre a mostrar; default: el del catálogo' })
	@Transform(trim)
	@IsString({ message: 'Nombre de producto inválido' })
	@MaxLength(200, { message: 'Producto: máximo 200 caracteres' })
	@IsOptional()
	product_name?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Cuenta inválida' })
	@MaxLength(128, { message: 'Cuenta: máximo 128 caracteres' })
	@IsOptional()
	account?: string;

	@ApiProperty({ description: 'Tipo de ítem (master data `item_types` del holding)' })
	// class-validator informa primero el decorador de más abajo: "Elige el tipo de ítem" cuando falta.
	@Transform(trim)
	@MaxLength(64, { message: 'Tipo de ítem: máximo 64 caracteres' })
	@MinLength(1, { message: 'Elige el tipo de ítem' })
	@IsString({ message: 'Elige el tipo de ítem' })
	item_type!: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Unidad inválida' })
	@MaxLength(32, { message: 'Unidad: máximo 32 caracteres' })
	@IsOptional()
	unit_of_measure?: string;

	@ApiProperty()
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad' })
	@Min(0.000001, { message: 'La cantidad debe ser mayor que 0' })
	quantity!: number;

	@ApiPropertyOptional({
		description: 'Precio unitario mensual. Obligatorio salvo con price_entry_mode annual o con un modelo de precio (`price` o `price_id`)',
	})
	@ValidateIf((item: CreateContractItemDto) => (item.price_entry_mode !== 'annual' && !usesPricingModel(item)) || item.unit_price !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario' })
	@Min(0, { message: 'El precio no puede ser negativo' })
	unit_price?: number;

	@ApiPropertyOptional({
		type: PriceSpecDto,
		description:
			'Pricing v2: modelo de precio inline del ítem (se guarda en `prices` con owner = contract). Sin él, el ítem es standard fijo (unit_price mensual × cantidad × meses). metered + Anticipado → 400 salvo seat',
	})
	@ValidateIf((_item: CreateContractItemDto, value: unknown) => value !== null && value !== undefined)
	@ValidateNested()
	@Type(() => PriceSpecDto)
	price?: PriceSpecDto | null;

	@ApiPropertyOptional({
		description:
			'Pricing v2 etapa 3: precio de catálogo (`GET /prices`, activo, del mismo producto y de la moneda del contrato). El contrato recibe su propia copia en `prices` (owner = contract, `list_price_id` = catálogo): cambios posteriores del catálogo no lo alteran. No se combina con `price`',
	})
	@IsUUID(undefined, { message: 'Precio de catálogo inválido' })
	@IsOptional()
	price_id?: string;

	@ApiPropertyOptional({
		description:
			'Solo lectura: precio de catálogo del que salió la copia del ítem (lo devuelve `GET /contracts/:id/form`). Al guardar se conserva si vuelve igual; para cambiar de catálogo manda `price_id`',
	})
	@IsUUID(undefined, { message: 'Precio de catálogo inválido' })
	@IsOptional()
	list_price_id?: string | null;

	@ApiPropertyOptional({ description: 'Precio unitario anual (con price_entry_mode annual)' })
	@ValidateIf((item: CreateContractItemDto) => item.price_entry_mode === 'annual' || item.annual_unit_price !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio anual' })
	@Min(0, { message: 'El precio anual no puede ser negativo' })
	annual_unit_price?: number;

	@ApiPropertyOptional({ enum: PRICE_ENTRY_MODES, default: 'monthly' })
	@IsIn(PRICE_ENTRY_MODES, { message: 'Modo de precio inválido' })
	@IsOptional()
	price_entry_mode?: (typeof PRICE_ENTRY_MODES)[number];

	@ApiPropertyOptional({ description: 'Descuento en porcentaje (0–100)' })
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento va de 0 a 100 %' })
	@Max(100, { message: 'El descuento va de 0 a 100 %' })
	@IsOptional()
	discount_value?: number;

	@ApiProperty({ enum: BILLING_FREQUENCIES })
	@IsIn(BILLING_FREQUENCIES, { message: 'Elige la frecuencia de facturación' })
	billing_frequency!: BillingFrequency;

	@ApiProperty({ enum: BILLING_METHODS })
	@IsIn(BILLING_METHODS, { message: 'Elige si se factura anticipado o vencido' })
	billing_method!: BillingMethod;

	@ApiProperty({ example: '2026-10-01' })
	@Matches(ISO_DATE, { message: 'Elige la fecha de inicio' })
	start_date!: string;

	@ApiPropertyOptional({
		description:
			'Plazo en meses (1–600). `null` = sin término (S1-12): solo en recurrentes; el ítem queda sin `end_date` y se facturan 12 períodos de horizonte. Un ítem de pago único siempre lleva plazo',
		nullable: true,
	})
	@ValidateIf((item: CreateContractItemDto) => item.is_recurring === false || (item.term_months !== null && item.term_months !== undefined))
	@IsInt({ message: 'El plazo va en meses enteros' })
	@Min(1, { message: 'El plazo mínimo es 1 mes' })
	@Max(600, { message: 'El plazo máximo es 600 meses' })
	term_months!: number | null;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'Indica si el ítem es recurrente' })
	@IsOptional()
	is_recurring?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Se respeta aunque la cotización diga otra cosa (S1-5)' })
	@IsBoolean({ message: 'Auto-renovación inválida' })
	@IsOptional()
	auto_renew?: boolean;

	@ApiPropertyOptional()
	@IsInt({ message: 'El plazo de renovación va en meses enteros' })
	@Min(1, { message: 'El plazo de renovación mínimo es 1 mes' })
	@Max(120, { message: 'El plazo de renovación máximo es 120 meses' })
	@IsOptional()
	auto_renew_term_months?: number;

	@ApiPropertyOptional({ description: 'Fecha de cierre del negocio (CMRR)' })
	@Matches(ISO_DATE, { message: 'Fecha de cierre inválida' })
	@IsOptional()
	booking_date?: string;

	@ApiPropertyOptional({
		enum: BILLING_CYCLES,
		default: 'contract',
		description:
			'§9.3.9: `own` = ciclo propio (billing_anchor_day = día de start_date): sus períodos parten ese día, sin tramo prorrateado, y emite en su propia fecha',
	})
	@IsIn(BILLING_CYCLES, { message: 'billing_cycle: contract u own' })
	@IsOptional()
	billing_cycle?: BillingCycle;
}

/** Body de `POST /contracts` y `POST /contracts/preview`. El holding sale de `HoldingScopeGuard`, nunca del body. */
export class CreateContractDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Elige un cliente' })
	client_id!: string;

	@ApiProperty({ description: 'Razón social (obligatoria)' })
	@IsUUID(undefined, { message: 'Elige la razón social' })
	client_entity_id!: string;

	@ApiProperty({ description: 'Compañía emisora' })
	@IsUUID(undefined, { message: 'Elige la compañía emisora' })
	company_id!: string;

	@ApiPropertyOptional({ description: 'Número manual; si se omite, correlativo {prefijo}-{año}-{NNN}' })
	@Transform(trim)
	@IsString({ message: 'Número de contrato inválido' })
	@MinLength(1, { message: 'Escribe el número de contrato' })
	@MaxLength(40, { message: 'Número de contrato: máximo 40 caracteres' })
	@Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { message: 'El número solo admite letras, números, punto, guion y guion bajo' })
	@IsOptional()
	contract_number?: string;

	@ApiProperty({ example: 'USD' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Elige la moneda del contrato' })
	contract_currency!: string;

	@ApiPropertyOptional({
		description:
			'Default: la moneda del contrato. Nunca CLF: un contrato en UF se factura en CLP por defecto si la compañía es CLP; si no, es obligatoria',
	})
	@Transform(upper)
	@IsNotIn([UF_CURRENCY], { message: UF_NOT_INVOICEABLE_MESSAGE })
	@Matches(CURRENCY, { message: 'Moneda de facturación inválida' })
	@IsOptional()
	invoice_currency?: string;

	@ApiPropertyOptional({
		enum: FX_INVOICE_POLICIES,
		description: 'Obligatorio si la moneda de facturación ≠ la del contrato: spot (del día, al emitir) o fixed (tasas fijas)',
	})
	@ValidateIf(
		(dto: CreateContractDto) =>
			dto.fx_invoice_policy !== undefined || Boolean(dto.invoice_currency && dto.invoice_currency !== dto.contract_currency)
	)
	@IsIn(FX_INVOICE_POLICIES, { message: 'Elige el tipo de cambio de facturación: del día o fijo' })
	fx_invoice_policy?: (typeof FX_INVOICE_POLICIES)[number];

	@ApiPropertyOptional({
		type: [FxRatePeriodDto],
		description:
			'Tasas fijas contrato → factura (solo con fx_invoice_policy fixed). Opcionales al crear: sin tasa, cada factura la recibe desde el 360 › Facturas antes de emitirse (el scheduler no emite sin tasa). `[{ rate }]` = una tasa para todo el contrato',
	})
	@ValidateIf((dto: CreateContractDto) => dto.fx_invoice_rates !== undefined)
	@ValidateNested({ each: true })
	@Type(() => FxPairRateDto)
	@ArrayMaxSize(FX_RATES_MAX, { message: `Máximo ${FX_RATES_MAX} tasas` })
	@IsArray({ message: 'Tasas fijas de facturación inválidas' })
	fx_invoice_rates?: FxPairRateDto[];

	@ApiPropertyOptional({
		type: [FxItemRateDto],
		description:
			'Multimoneda: tasas fijas pactadas ítem → contrato (`purpose = item`), una por moneda de ítem ≠ moneda del contrato (400 item_fx_rate_missing). `[{ from_currency, rate }]` = todo el contrato',
	})
	@ValidateIf((dto: CreateContractDto) => dto.fx_item_rates !== undefined)
	@ValidateNested({ each: true })
	@Type(() => FxItemRateDto)
	@ArrayMaxSize(FX_RATES_MAX, { message: `Máximo ${FX_RATES_MAX} tasas` })
	@IsArray({ message: 'Tasas ítem → contrato inválidas' })
	fx_item_rates?: FxItemRateDto[];

	@ApiPropertyOptional({
		enum: FX_COMPANY_POLICIES,
		default: 'company_default',
		description: 'Solo si la moneda del contrato ≠ la de la compañía: company_default (la de la compañía) o fixed_period (tasas propias)',
	})
	@IsIn(FX_COMPANY_POLICIES, { message: 'Elige cómo se convierte a la moneda de la compañía' })
	@IsOptional()
	fx_company_policy?: (typeof FX_COMPANY_POLICIES)[number];

	@ApiPropertyOptional({
		type: [FxRatePeriodDto],
		description: 'Tasas fijas contrato → compañía (al menos una con fx_company_policy fixed_period)',
	})
	@ValidateIf((dto: CreateContractDto) => dto.fx_company_policy === 'fixed_period' || dto.fx_company_rates !== undefined)
	@ValidateNested({ each: true })
	@Type(() => FxRatePeriodDto)
	@ArrayMaxSize(FX_RATES_MAX, { message: `Máximo ${FX_RATES_MAX} tasas` })
	// class-validator informa primero el decorador de más abajo: "Agrega la tasa" cuando falta.
	@ArrayMinSize(1, { message: 'Agrega la tasa fija de la compañía' })
	@IsArray({ message: 'Agrega la tasa fija de la compañía' })
	fx_company_rates?: FxRatePeriodDto[];

	@ApiPropertyOptional({ type: PaymentTermsDto, description: 'Default: la de la razón social' })
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	@IsOptional()
	payment_terms?: PaymentTermsDto;

	@ApiPropertyOptional({
		description:
			'Documento tributario del catálogo (`form-options.companies[].tax_document_types`). Debe ser del país de la compañía emisora (o genérico si el país no tiene catálogo). Default: `suggested_tax_document_type_id`. Fija `document_type` por su familia',
	})
	@IsUUID(undefined, { message: 'Documento tributario inválido' })
	@IsOptional()
	tax_document_type_id?: string;

	@ApiPropertyOptional({
		enum: CONTRACT_DOCUMENT_TYPES,
		description: 'Familia del documento. Solo se usa si no hay documento tributario del catálogo; default: sugerido por país emisor vs receptor',
	})
	@IsIn(CONTRACT_DOCUMENT_TYPES, { message: 'Tipo de documento inválido' })
	@IsOptional()
	document_type?: ContractDocumentType;

	@ApiPropertyOptional({
		description: 'Día de ciclo 1–31; ausente/null = automático (se guarda NULL y el generador usa el día del primer inicio de los recurrentes)',
		nullable: true,
	})
	@IsInt({ message: 'Día de ciclo inválido' })
	@Min(1, { message: 'El día de ciclo va de 1 a 31' })
	@Max(31, { message: 'El día de ciclo va de 1 a 31' })
	@IsOptional()
	billing_anchor_day?: number | null;

	@ApiPropertyOptional({ default: true, description: 'true = ítems juntos por mes de emisión; false = una factura por ítem' })
	@IsBoolean({ message: 'Agrupación inválida' })
	@IsOptional()
	group_invoices_by_period?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Apagado por defecto (S6-10)' })
	@IsBoolean({ message: 'Envío automático a Odoo inválido' })
	@IsOptional()
	auto_send_to_odoo?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Requiere auto_send_to_odoo (S6-10); ambos requieren integración con el ERP en la compañía' })
	@IsBoolean({ message: 'Facturación automática inválida' })
	@IsOptional()
	auto_invoice?: boolean;

	@ApiPropertyOptional({
		description: 'Fecha de cierre del negocio; default: la de la cotización (o se fija al activar). En PUT, null la borra',
		nullable: true,
	})
	@Matches(ISO_DATE, { message: 'Fecha de cierre inválida' })
	@IsOptional()
	booking_date?: string | null;

	@ApiPropertyOptional({ description: 'Cotización firmada de origen' })
	@IsUUID(undefined, { message: 'Cotización inválida' })
	@IsOptional()
	quote_id?: string;

	@ApiPropertyOptional({ description: 'Oportunidad del CRM. En PUT, null (o texto vacío) la borra', nullable: true })
	@Transform(trim)
	@IsString({ message: 'Oportunidad inválida' })
	@MaxLength(40, { message: 'Oportunidad: máximo 40 caracteres' })
	@IsOptional()
	salesforce_opportunity_id?: string | null;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(5000, { message: 'Las notas no pueden superar 5.000 caracteres' })
	@IsOptional()
	notes?: string;

	@ApiPropertyOptional({ description: 'Texto para el campo narration de las facturas en el ERP (no son condiciones de pago)' })
	@IsString({ message: 'Condiciones inválidas' })
	@MaxLength(5000, { message: 'Las condiciones no pueden superar 5.000 caracteres' })
	@IsOptional()
	invoice_terms_and_conditions?: string;

	@ApiPropertyOptional({ type: Object })
	@IsObject({ message: 'Campos personalizados inválidos' })
	@IsOptional()
	custom_fields?: Record<string, unknown>;

	@ApiPropertyOptional({
		default: false,
		description: 'S1-15: se factura desde más de una compañía del holding. Default: lo que diga la cotización, si hay',
	})
	@IsBoolean({ message: 'Marca multiempresa inválida' })
	@IsOptional()
	requires_multicompany_billing?: boolean;

	@ApiPropertyOptional({
		default: false,
		description:
			'Multimoneda (spec-multimoneda §2): ítems en distinta moneda facturados en un solo documento. Default: `quotes.requires_multicurrency` de la cotización de origen, si hay',
	})
	@IsBoolean({ message: 'Marca multimoneda inválida' })
	@IsOptional()
	requires_multicurrency_billing?: boolean;

	@ApiPropertyOptional({
		default: false,
		description: 'S1-15: las facturas no se emiten sin referencia (OC/HES). Default: lo que diga la cotización, si hay',
	})
	@IsBoolean({ message: 'Marca de referencias inválida' })
	@IsOptional()
	requires_references_for_billing?: boolean;

	@ApiProperty({ type: [CreateContractItemDto] })
	@IsArray({ message: 'Agrega al menos un ítem' })
	@ArrayMinSize(1, { message: 'Agrega al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por contrato' })
	@ValidateNested({ each: true })
	@Type(() => CreateContractItemDto)
	items!: CreateContractItemDto[];

	@ApiPropertyOptional({
		type: [CreateScheduledChangeDto],
		description:
			'Ajustes pactados al crear (§9.3.6, mismo DTO que `POST /contracts/:id/scheduled-changes`, con `item_key` = `key` del ítem). En `PUT` reemplaza los pactos `scheduled` del borrador; ausente = no se tocan',
	})
	@IsArray({ message: 'scheduled_changes debe ser una lista' })
	@ArrayMaxSize(200)
	@ValidateNested({ each: true })
	@Type(() => CreateScheduledChangeDto)
	@IsOptional()
	scheduled_changes?: CreateScheduledChangeDto[];
}

/** Ítem de `PUT /contracts/:id`: con `id` actualiza el ítem existente del borrador; sin `id` lo crea. */
export class UpdateContractItemDto extends CreateContractItemDto {
	@ApiPropertyOptional({ description: 'Ítem existente del borrador (`GET /contracts/:id/form`). Los ítems del borrador que no vengan se eliminan' })
	@IsUUID(undefined, { message: 'Ítem del contrato inválido' })
	@IsOptional()
	id?: string;
}

/**
 * Body de `PUT /contracts/:id` (solo borradores): el formulario completo, con las mismas reglas que crear. El número de
 * contrato y la cotización de origen no cambian al editar (`contract_number` y `quote_id` se validan pero no se reasignan).
 */
export class UpdateContractDto extends CreateContractDto {
	@ApiProperty({ type: [UpdateContractItemDto] })
	@IsArray({ message: 'Agrega al menos un ítem' })
	@ArrayMinSize(1, { message: 'Agrega al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por contrato' })
	@ValidateNested({ each: true })
	@Type(() => UpdateContractItemDto)
	items!: UpdateContractItemDto[];
}

/** Body de `PATCH /contracts/:id/terms`. `null` borra las condiciones. */
export class UpdateContractTermsDto {
	@ApiProperty({ description: 'Texto para el campo narration de las facturas en el ERP (acepta HTML); null lo borra', nullable: true })
	@ValidateIf((_dto: UpdateContractTermsDto, value: unknown) => value !== null)
	// class-validator informa primero el decorador de más abajo: "Escribe las condiciones" cuando falta.
	@MaxLength(5000, { message: 'Las condiciones no pueden superar 5.000 caracteres' })
	@IsString({ message: 'Escribe las condiciones de factura (o null para borrarlas)' })
	invoice_terms_and_conditions!: string | null;
}

/** Body de `POST /contracts/price-preview` (Pricing v2 §5): simula un precio para varias cantidades sin guardar nada. */
export class PricePreviewDto {
	@ApiProperty({ type: PriceSpecDto })
	@ValidateNested()
	@Type(() => PriceSpecDto)
	@IsObject({ message: 'Define el precio a simular' })
	price!: PriceSpecDto;

	@ApiPropertyOptional({ description: 'Descuento del ítem en porcentaje (0–100)', default: 0 })
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento va de 0 a 100 %' })
	@Max(100, { message: 'El descuento va de 0 a 100 %' })
	@IsOptional()
	discount_pct?: number;

	@ApiProperty({ type: [Number], description: 'Cantidades a simular (una línea por cantidad)', example: [300, 1250, 1400] })
	@IsArray({ message: 'Indica al menos una cantidad a simular' })
	@ArrayMinSize(1, { message: 'Indica al menos una cantidad a simular' })
	@ArrayMaxSize(50, { message: 'Máximo 50 cantidades por simulación' })
	@IsNumber({ maxDecimalPlaces: 6 }, { each: true, message: 'Cantidad a simular inválida' })
	@Min(0, { each: true, message: 'La cantidad a simular no puede ser negativa' })
	quantities!: number[];
}
