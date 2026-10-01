import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { PaymentTermsDto } from '@/modules/clients/dtos/client-directory.dto';

import { BILLING_FREQUENCIES, BILLING_METHODS, type BillingFrequency, type BillingMethod } from '../billing-engine';

import { FX_INVOICE_POLICIES, FX_RATES_MAX, FxRatePeriodDto, PRICE_ENTRY_MODES, PriceSpecDto } from './create-contract.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY = /^[A-Z]{2,4}$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

/** Tipos de cambio construidos (spec §4, fases A–D). */
export const CHANGE_TYPES = ['billing_conditions', 'change_entity', 'item_remove', 'contract_cancel', 'renewal', 'item_add', 'item_change'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/** Tipos que la spec deja ABIERTOS: se rechazan con 400 explicando qué falta decidir (§2.6, §2.7, §2.8). */
export const DEFERRED_CHANGE_TYPES = ['reactivate', 'pause', 'resume', 'price_adjustment'] as const;
export const ORIGIN_TYPES = ['manual', 'quote'] as const;
export const FIRST_PERIOD_INVOICE = ['cycle', 'immediate'] as const;
export type FirstPeriodInvoice = (typeof FIRST_PERIOD_INVOICE)[number];
export const RENEWAL_CATCH_UP = ['backdate', 'current_month'] as const;
export const CHANGE_ITEMS_MAX = 100;

export class ChangeOriginDto {
	@ApiProperty({ enum: ORIGIN_TYPES, description: 'manual o cotización ganada' })
	@IsIn(ORIGIN_TYPES, { message: 'Origen inválido: manual o quote' })
	type!: (typeof ORIGIN_TYPES)[number];

	@ApiPropertyOptional({ description: 'Cotización del holding (obligatoria si type = quote)' })
	@ValidateIf((origin: ChangeOriginDto) => origin.type === 'quote')
	@IsUUID(undefined, { message: 'Indica la cotización de origen' })
	quote_id?: string;
}

/** Ítem de `item_change`: valores nuevos completos (manual §8). Frecuencia y fin no se cambian aquí (ABIERTO S3-15 → `renewal`). */
export class ItemChangeItemDto {
	@ApiProperty({ description: 'Ítem base (fila del ítem madre)' })
	@IsUUID(undefined, { message: 'Ítem inválido' })
	item_id!: string;

	@ApiProperty({ description: 'Cantidad nueva total del producto' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad nueva' })
	@Min(0.000001, { message: 'La cantidad nueva debe ser mayor que 0; para quitar el producto usa item_remove' })
	quantity!: number;

	@ApiProperty({ description: 'Unitario nuevo (mensual, o anual si price_entry_mode = annual)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario nuevo' })
	@Min(0.000001, { message: 'El precio unitario nuevo debe ser mayor que 0; para quitar el producto usa item_remove' })
	unit_price!: number;

	@ApiPropertyOptional({ enum: PRICE_ENTRY_MODES, default: 'monthly' })
	@IsIn(PRICE_ENTRY_MODES, { message: 'Modo de precio inválido: monthly o annual' })
	@IsOptional()
	price_entry_mode?: (typeof PRICE_ENTRY_MODES)[number];

	@ApiPropertyOptional({ description: 'Descuento % nuevo (default: el del ítem, manual #15)' })
	@ValidateIf((_item: ItemChangeItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento no puede ser negativo' })
	@Max(100, { message: 'El descuento no puede superar 100 %' })
	discount_value?: number | null;

	@ApiPropertyOptional({
		description: 'Upsell: reescribir la línea Por Emitir al neto en vez de agregar una línea (S3-14). En downsell siempre es neta',
	})
	@IsBoolean({ message: 'net_line debe ser true o false' })
	@IsOptional()
	net_line?: boolean;

	@ApiPropertyOptional({ description: 'No se acepta: renegociar la frecuencia es `renewal` (ABIERTO S3-15)' })
	@IsOptional()
	billing_frequency?: string;

	@ApiPropertyOptional({ description: 'No se acepta: cambiar el fin es `renewal` o `item_remove` (D-B)' })
	@IsOptional()
	end_date?: string;
}

/** Ítem de `item_add`: producto nuevo (cross-sell) o existente (upsell de ítem nuevo, Supuesto 2). Hereda del contrato lo que no venga (S3-19). */
export class ItemAddItemDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Producto inválido' })
	product_id!: string;

	@ApiProperty()
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad' })
	@Min(0.000001, { message: 'La cantidad debe ser mayor que 0' })
	quantity!: number;

	@ApiPropertyOptional({
		description:
			'Unitario mensual (o anual si price_entry_mode = annual). Obligatorio salvo que venga `price` con un modelo distinto de standard fijo o `price_id` de catálogo',
	})
	@ValidateIf(
		(item: ItemAddItemDto) => !item.price_id && !(item.price && !(item.price.model === 'standard' && item.price.quantity_type === 'fixed'))
	)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario' })
	@Min(0, { message: 'El precio unitario no puede ser negativo' })
	unit_price?: number;

	@ApiPropertyOptional({
		description:
			'Pricing v2 etapa 3: precio de catálogo (activo, del mismo producto y de la moneda del contrato). El ítem recibe su propia copia en `prices` (owner = contract, `list_price_id`). No se combina con `price`',
	})
	@IsUUID(undefined, { message: 'Precio de catálogo inválido' })
	@IsOptional()
	price_id?: string;

	@ApiPropertyOptional({
		type: PriceSpecDto,
		description:
			'Pricing v2: modelo de precio inline (misma forma que en crear contrato). Se guarda en `prices` (owner = contract) y el ítem lo apunta con `price_id`; el generador lo usa para sus facturas. Medido + Anticipado → 400 salvo seat',
	})
	@ValidateIf((_item: ItemAddItemDto, value: unknown) => present(value))
	@IsObject({ message: 'Modelo de precio inválido' })
	@ValidateNested()
	@Type(() => PriceSpecDto)
	price?: PriceSpecDto | null;

	@ApiPropertyOptional({ enum: PRICE_ENTRY_MODES, default: 'monthly' })
	@IsIn(PRICE_ENTRY_MODES, { message: 'Modo de precio inválido: monthly o annual' })
	@IsOptional()
	price_entry_mode?: (typeof PRICE_ENTRY_MODES)[number];

	@ApiPropertyOptional({ description: 'Descuento %' })
	@ValidateIf((_item: ItemAddItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento no puede ser negativo' })
	@Max(100, { message: 'El descuento no puede superar 100 %' })
	discount_value?: number | null;

	@ApiPropertyOptional({ description: 'Tipo de ítem (master data del holding); default: el del ítem relacionado o del primer recurrente' })
	@Transform(trim)
	@IsString({ message: 'Tipo de ítem inválido' })
	@MaxLength(80)
	@IsOptional()
	item_type?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Unidad inválida' })
	@MaxLength(40)
	@IsOptional()
	unit_of_measure?: string;

	@ApiPropertyOptional({ description: 'Cuenta (separa el ítem madre)' })
	@Transform(trim)
	@IsString({ message: 'Cuenta inválida' })
	@MaxLength(128)
	@IsOptional()
	account?: string;

	@ApiPropertyOptional({ enum: BILLING_FREQUENCIES, description: 'Default: la del ítem relacionado o del contrato' })
	@IsIn(BILLING_FREQUENCIES, { message: 'Frecuencia inválida' })
	@IsOptional()
	billing_frequency?: BillingFrequency;

	@ApiPropertyOptional({ enum: BILLING_METHODS, description: 'Default: el del ítem relacionado o del contrato' })
	@IsIn(BILLING_METHODS, { message: 'Método de facturación inválido' })
	@IsOptional()
	billing_method?: BillingMethod;

	@ApiPropertyOptional({ description: 'Default: la fecha efectiva' })
	@Matches(ISO_DATE, { message: 'Fecha de inicio inválida (YYYY-MM-DD)' })
	@IsOptional()
	start_date?: string;

	@ApiPropertyOptional({ description: 'Default: fin del contrato (co-terminación, D-B). Si lo supera se acota con aviso' })
	@Matches(ISO_DATE, { message: 'Fecha de fin inválida (YYYY-MM-DD)' })
	@IsOptional()
	end_date?: string;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'is_recurring debe ser true o false' })
	@IsOptional()
	is_recurring?: boolean;
}

export class ItemRefDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Ítem inválido' })
	item_id!: string;
}

/** Ítem de `renewal`: mismo precio (S3-15 por confirmar → cantidad/unitario/descuento nuevos se rechazan hasta que Domi cierre el almacenamiento). */
export class RenewalItemDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Ítem inválido' })
	item_id!: string;

	@ApiPropertyOptional({ description: 'Plazo de la renovación en meses (default: el del ítem)' })
	@IsInt({ message: 'El plazo debe ser un entero de meses' })
	@Min(1, { message: 'El plazo mínimo es 1 mes' })
	@Max(120, { message: 'El plazo máximo es 120 meses' })
	@IsOptional()
	term_months?: number;

	@ApiPropertyOptional({ description: 'Fin explícito de la renovación (meses enteros desde el día siguiente al fin actual)' })
	@Matches(ISO_DATE, { message: 'Fecha de fin inválida (YYYY-MM-DD)' })
	@IsOptional()
	end_date?: string;

	@ApiPropertyOptional({ enum: BILLING_FREQUENCIES, description: 'Default editable (S3-19): la del ítem' })
	@IsIn(BILLING_FREQUENCIES, { message: 'Frecuencia inválida' })
	@IsOptional()
	billing_frequency?: BillingFrequency;

	@ApiPropertyOptional({ enum: BILLING_METHODS, description: 'Default editable (S3-19): el del ítem' })
	@IsIn(BILLING_METHODS, { message: 'Método de facturación inválido' })
	@IsOptional()
	billing_method?: BillingMethod;

	@ApiPropertyOptional({ description: 'No se acepta hasta cerrar S3-15' })
	@IsOptional()
	quantity?: number;

	@ApiPropertyOptional({ description: 'No se acepta hasta cerrar S3-15' })
	@IsOptional()
	unit_price?: number;

	@ApiPropertyOptional({ description: 'No se acepta hasta cerrar S3-15' })
	@IsOptional()
	discount_value?: number;
}

/**
 * Payload discriminado por `type`. Los campos que no aplican al tipo se ignoran; la coherencia por tipo la valida
 * `validateChangePayload` (`contract-changes.ts`) con `errors[{ field: change.<campo> }]`.
 */
export class ContractChangeDto {
	@ApiProperty({ enum: [...CHANGE_TYPES, ...DEFERRED_CHANGE_TYPES] })
	@IsIn([...CHANGE_TYPES, ...DEFERRED_CHANGE_TYPES], { message: 'Tipo de cambio inválido' })
	type!: ChangeType | (typeof DEFERRED_CHANGE_TYPES)[number];

	// ---- ítems (item_change, item_add, item_remove, renewal)
	@ApiPropertyOptional({ description: 'Ítems según el tipo (ItemChangeItemDto | ItemAddItemDto | ItemRefDto | RenewalItemDto)' })
	@IsArray({ message: 'items debe ser una lista' })
	@ArrayMaxSize(CHANGE_ITEMS_MAX, { message: `Máximo ${CHANGE_ITEMS_MAX} ítems por cambio` })
	@IsOptional()
	items?: Array<Record<string, unknown>>;

	@ApiPropertyOptional({
		enum: FIRST_PERIOD_INVOICE,
		default: 'cycle',
		description: 'Upsell y cross-sell: tramo inicial en la factura del ciclo o suelta (S3-17)',
	})
	@IsIn(FIRST_PERIOD_INVOICE, { message: 'first_period_invoice: cycle o immediate' })
	@IsOptional()
	first_period_invoice?: FirstPeriodInvoice;

	@ApiPropertyOptional({
		enum: ['auto'],
		default: 'auto',
		description: 'item_remove: early si la fecha efectiva ≤ fin del ítem, si no non-renewal',
	})
	@IsIn(['auto'], { message: 'timing: solo auto' })
	@IsOptional()
	timing?: 'auto';

	@ApiPropertyOptional({ enum: RENEWAL_CATCH_UP, default: 'backdate', description: 'renewal retroactiva (S5-4): solo backdate está construido' })
	@IsIn(RENEWAL_CATCH_UP, { message: 'catch_up: backdate o current_month' })
	@IsOptional()
	catch_up?: (typeof RENEWAL_CATCH_UP)[number];

	// ---- billing_conditions
	@ApiPropertyOptional({ type: PaymentTermsDto, nullable: true })
	@ValidateIf((_change: ContractChangeDto, value: unknown) => present(value))
	@IsObject({ message: 'Condición de pago inválida' })
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	payment_terms?: PaymentTermsDto | null;

	@ApiPropertyOptional({ nullable: true, description: 'Texto de condiciones de factura (null = quitar)' })
	@ValidateIf((_change: ContractChangeDto, value: unknown) => present(value))
	@IsString({ message: 'Condiciones inválidas' })
	@MaxLength(5000, { message: 'Las condiciones no pueden superar 5.000 caracteres' })
	invoice_terms_and_conditions?: string | null;

	@ApiPropertyOptional({
		description:
			'billing_conditions: con un texto de condiciones nuevo, también se escribe en las Por Emitir activas desde la fecha efectiva (mismas reglas y bloqueos que el masivo de facturas; las bloqueadas se omiten y se informan). Sin cambio de condiciones → 400',
	})
	@IsBoolean({ message: 'apply_to_pending debe ser true o false' })
	@IsOptional()
	apply_to_pending?: boolean;

	@ApiPropertyOptional({ description: 'Documento tributario del catálogo (debe corresponder a la compañía emisora)' })
	@IsUUID(undefined, { message: 'Documento tributario inválido' })
	@IsOptional()
	tax_document_type_id?: string;

	@ApiPropertyOptional({ enum: ['FACTURA', 'FACTURA_EXPORTACION'], description: 'Familia del documento cuando el holding no tiene catálogo' })
	@IsIn(['FACTURA', 'FACTURA_EXPORTACION'], { message: 'Tipo de documento inválido' })
	@IsOptional()
	document_type?: 'FACTURA' | 'FACTURA_EXPORTACION';

	@ApiPropertyOptional({ description: 'Envío automático al ERP' })
	@IsBoolean({ message: 'auto_send_to_odoo debe ser true o false' })
	@IsOptional()
	auto_send_to_odoo?: boolean;

	@ApiPropertyOptional({ description: 'Emisión automática (exige envío al ERP, S6-10)' })
	@IsBoolean({ message: 'auto_invoice debe ser true o false' })
	@IsOptional()
	auto_invoice?: boolean;

	@ApiPropertyOptional({ description: 'Exige OC/HES antes de emitir' })
	@IsBoolean({ message: 'requires_references_for_billing debe ser true o false' })
	@IsOptional()
	requires_references_for_billing?: boolean;

	@ApiPropertyOptional({ description: 'Facturas juntas por período (true) o una por ítem (false); rige para lo que se genere después' })
	@IsBoolean({ message: 'group_invoices_by_period debe ser true o false' })
	@IsOptional()
	group_invoices_by_period?: boolean;

	@ApiPropertyOptional({ description: 'Moneda de facturación de las Por Emitir desde la fecha efectiva (nunca UF)' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda de facturación inválida' })
	@IsOptional()
	invoice_currency?: string;

	@ApiPropertyOptional({ enum: FX_INVOICE_POLICIES, description: 'Obligatoria si la moneda de facturación difiere de la del contrato' })
	@IsIn(FX_INVOICE_POLICIES, { message: 'Política de tipo de cambio inválida: spot o fixed' })
	@IsOptional()
	fx_invoice_policy?: (typeof FX_INVOICE_POLICIES)[number];

	@ApiPropertyOptional({ type: [FxRatePeriodDto], description: 'Tasas fijas contrato → moneda de factura (fixed); se agregan a las guardadas' })
	@IsArray({ message: 'fx_invoice_rates debe ser una lista' })
	@ArrayMaxSize(FX_RATES_MAX)
	@ValidateNested({ each: true })
	@Type(() => FxRatePeriodDto)
	@IsOptional()
	fx_invoice_rates?: FxRatePeriodDto[];

	// ---- change_entity
	@ApiPropertyOptional({ description: 'Razón social receptora nueva (del mismo cliente comercial)' })
	@IsUUID(undefined, { message: 'Razón social inválida' })
	@IsOptional()
	client_entity_id?: string;

	@ApiPropertyOptional({ description: 'No se acepta: cambiar el cliente comercial está ABIERTO (spec §2.10 a)' })
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional({ default: true, description: 'Reasignar las Por Emitir con emisión desde la fecha efectiva' })
	@IsBoolean({ message: 'apply_to_pending_invoices debe ser true o false' })
	@IsOptional()
	apply_to_pending_invoices?: boolean;
}

/** Body de `POST /contracts/:id/changes` y `POST /contracts/:id/changes/preview` (spec §4). */
export class ContractChangeRequestDto {
	@ApiProperty({ example: '2026-11-01', description: 'Fecha efectiva: deriva cortes, churn_date, NC y RSM' })
	@Matches(ISO_DATE, { message: 'Fecha efectiva inválida (YYYY-MM-DD)' })
	effective_date!: string;

	@ApiPropertyOptional({ type: ChangeOriginDto, default: { type: 'manual' } })
	@IsObject({ message: 'Origen inválido' })
	@ValidateNested()
	@Type(() => ChangeOriginDto)
	@IsOptional()
	origin?: ChangeOriginDto;

	@ApiPropertyOptional({ description: 'Motivo libre (obligatorio si hay advertencias o en bajas sin reason_id)' })
	@Transform(trim)
	@IsString({ message: 'Motivo inválido' })
	@MaxLength(500, { message: 'El motivo no puede superar 500 caracteres' })
	@IsOptional()
	reason?: string;

	@ApiPropertyOptional({ description: 'Motivo de catálogo (`churn_reasons`) para bajas y cancelación' })
	@IsUUID(undefined, { message: 'Motivo de catálogo inválido' })
	@IsOptional()
	reason_id?: string;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(2000, { message: 'Las notas no pueden superar 2.000 caracteres' })
	@IsOptional()
	notes?: string;

	@ApiProperty({ type: ContractChangeDto })
	@IsObject({ message: 'Indica el cambio' })
	@ValidateNested()
	@Type(() => ContractChangeDto)
	change!: ContractChangeDto;
}
