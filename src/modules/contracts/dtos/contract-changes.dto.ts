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

import {
	BILLING_CYCLES,
	type BillingCycle,
	FX_INVOICE_POLICIES,
	FX_RATES_MAX,
	FxItemRateDto,
	FxPairRateDto,
	PRICE_ENTRY_MODES,
	PriceSpecDto,
} from './create-contract.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY = /^[A-Z]{2,4}$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

/**
 * Tipos de cambio construidos (spec §4, fases A–D; `multicurrency` = activar/desactivar multimoneda, spec-multimoneda §6; `reactivate` =
 * revertir el churn o reactivar, §9.3.2; `pause` / `resume` = pausar y reanudar el servicio por ítem, §9.3.3).
 */
export const CHANGE_TYPES = [
	'billing_conditions',
	'change_entity',
	'item_remove',
	'contract_cancel',
	'renewal',
	'item_add',
	'item_change',
	'multicurrency',
	'reactivate',
	'pause',
	'resume',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/** Tipos que no se construyen como cambio: se rechazan con 400 explicando el camino (reajuste = pactos §9.3.6). */
export const DEFERRED_CHANGE_TYPES = ['price_adjustment'] as const;
/** `contract_cancel` (§9.3.1): qué hacer con cada factura con período desde la fecha efectiva. */
export const INVOICE_DECISION_ACTIONS = ['emit', 'cancel', 'keep', 'void'] as const;
export type InvoiceDecisionAction = (typeof INVOICE_DECISION_ACTIONS)[number];

/** Origen del cambio: manual, cotización ganada o propuesta de renovación del job `contracts-auto-renewal` (§9.3.5). */
export const ORIGIN_TYPES = ['manual', 'quote', 'renewal_proposal'] as const;
export const FIRST_PERIOD_INVOICE = ['cycle', 'immediate'] as const;
export type FirstPeriodInvoice = (typeof FIRST_PERIOD_INVOICE)[number];
export const RENEWAL_CATCH_UP = ['backdate', 'current_month'] as const;
export const CHANGE_ITEMS_MAX = 100;

export class ChangeOriginDto {
	@ApiProperty({ enum: ORIGIN_TYPES, description: 'manual, cotización ganada o propuesta de renovación (confirmar, §9.3.5)' })
	@IsIn(ORIGIN_TYPES, { message: 'Origen inválido: manual, quote o renewal_proposal' })
	type!: (typeof ORIGIN_TYPES)[number];

	@ApiPropertyOptional({ description: 'Cotización del holding (obligatoria si type = quote)' })
	@ValidateIf((origin: ChangeOriginDto) => origin.type === 'quote')
	@IsUUID(undefined, { message: 'Indica la cotización de origen' })
	quote_id?: string;

	@ApiPropertyOptional({
		description: 'Evento RENEWAL_PROPOSED que se confirma (obligatorio si type = renewal_proposal; solo con change.type = renewal)',
	})
	@ValidateIf((origin: ChangeOriginDto) => origin.type === 'renewal_proposal')
	@IsUUID(undefined, { message: 'Indica la propuesta de renovación (event_id)' })
	event_id?: string;
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

	@ApiPropertyOptional({
		enum: BILLING_FREQUENCIES,
		description:
			'§9.3.7: frecuencia nueva. El ítem se corta al próximo inicio de período y nace un RENEWAL con la frecuencia nueva al mismo mensual (+ ajuste si cambia el precio)',
	})
	@IsIn(BILLING_FREQUENCIES, { message: 'Frecuencia inválida' })
	@IsOptional()
	billing_frequency?: BillingFrequency;

	@ApiPropertyOptional({ description: '§9.3.7: plazo nuevo en meses desde el corte (próximo inicio de período). Default: lo que le quedaba' })
	@IsInt({ message: 'El plazo debe ser un entero de meses' })
	@Min(1, { message: 'El plazo mínimo es 1 mes' })
	@Max(120, { message: 'El plazo máximo es 120 meses' })
	@IsOptional()
	term_months?: number;

	@ApiPropertyOptional({ description: 'Ítem de la cotización de origen (origin.type = quote): queda registrado en el ajuste (`quote_item_id`)' })
	@IsUUID(undefined, { message: 'Ítem de cotización inválido' })
	@IsOptional()
	quote_item_id?: string;

	@ApiPropertyOptional({ description: 'No se acepta: cambiar el fin es `renewal` o `item_remove` (D-B)' })
	@IsOptional()
	end_date?: string;
}

/** Ítem de `item_add`: producto nuevo (cross-sell) o existente (upsell de ítem nuevo, Supuesto 2). Hereda del contrato lo que no venga (S3-19). */
export class ItemAddItemDto {
	@ApiPropertyOptional({ description: 'Obligatorio salvo que venga `quote_item_id` (se toma el de la cotización)' })
	@ValidateIf((item: ItemAddItemDto) => !item.quote_item_id || present(item.product_id))
	@IsUUID(undefined, { message: 'Producto inválido' })
	product_id?: string;

	@ApiPropertyOptional({
		description:
			'Ítem de la cotización de origen (origin.type = quote): lo que no venga en el pedido (producto, cantidad, precio o modelo, descuento, frecuencia, método, inicio, cuenta) sale de él y el ítem nuevo queda con `quote_item_id`',
	})
	@IsUUID(undefined, { message: 'Ítem de cotización inválido' })
	@IsOptional()
	quote_item_id?: string;

	@ApiPropertyOptional({
		enum: BILLING_CYCLES,
		default: 'contract',
		description: '§9.3.9: `own` = ciclo propio (día de su inicio, sin tramo prorrateado; se factura en su propia fecha de emisión)',
	})
	@IsIn(BILLING_CYCLES, { message: 'billing_cycle: contract u own' })
	@IsOptional()
	billing_cycle?: BillingCycle;

	@ApiPropertyOptional({
		example: 'USD',
		description:
			'Multimoneda: moneda del ítem. Default: la de la cotización de origen (origin.type = quote) o la del contrato. Distinta de la del contrato exige multimoneda activa o `enable_multicurrency` (blocker multicurrency_not_enabled)',
	})
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda del ítem inválida' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ description: 'Obligatoria salvo que venga `quote_item_id`' })
	@ValidateIf((item: ItemAddItemDto) => !item.quote_item_id || present(item.quantity))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad' })
	@Min(0.000001, { message: 'La cantidad debe ser mayor que 0' })
	quantity?: number;

	@ApiPropertyOptional({
		description:
			'Unitario mensual (o anual si price_entry_mode = annual). Obligatorio salvo que venga `price` con un modelo distinto de standard fijo, `price_id` de catálogo o `quote_item_id`',
	})
	@ValidateIf(
		(item: ItemAddItemDto) =>
			(!item.quote_item_id || present(item.unit_price)) &&
			!item.price_id &&
			!(item.price && !(item.price.model === 'standard' && item.price.quantity_type === 'fixed'))
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

/**
 * Ítem de `renewal` (§9.3.4): sin valores = mismo precio. Con `quantity`/`unit_price`/`discount_value` = RENEWAL al valor vigente + ítem de
 * ajuste UPSELL/DOWNSELL (S3-15, dos ítems) y una fila `contract_scheduled_changes` `on_renewal` `applied` que lo registra.
 */
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

	@ApiPropertyOptional({ description: 'Cantidad nueva de la renovación (default: la vigente del ítem madre)' })
	@ValidateIf((_item: RenewalItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad nueva' })
	@Min(0.000001, { message: 'La cantidad nueva debe ser mayor que 0; para no renovar usa item_remove' })
	quantity?: number | null;

	@ApiPropertyOptional({ description: 'Unitario nuevo (mensual, o anual si price_entry_mode = annual; default: el vigente)' })
	@ValidateIf((_item: RenewalItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario nuevo' })
	@Min(0.000001, { message: 'El precio unitario nuevo debe ser mayor que 0' })
	unit_price?: number | null;

	@ApiPropertyOptional({ enum: PRICE_ENTRY_MODES, default: 'monthly' })
	@IsIn(PRICE_ENTRY_MODES, { message: 'Modo de precio inválido: monthly o annual' })
	@IsOptional()
	price_entry_mode?: (typeof PRICE_ENTRY_MODES)[number];

	@ApiPropertyOptional({ description: 'Descuento % nuevo (default: el vigente)' })
	@ValidateIf((_item: RenewalItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento no puede ser negativo' })
	@Max(100, { message: 'El descuento no puede superar 100 %' })
	discount_value?: number | null;
}

/** Ítem de `reactivate` (§9.3.2): sin lista = todo lo cancelado. Cantidad/unitario solo cambian en la rama de mes cerrado (REACTIVATION nuevo). */
export class ReactivateItemDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Ítem inválido' })
	item_id!: string;

	@ApiPropertyOptional({ description: 'Rama c (mes cerrado): cantidad del REACTIVATION (default: la anterior)' })
	@ValidateIf((_item: ReactivateItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Cantidad inválida' })
	@Min(0.000001, { message: 'La cantidad debe ser mayor que 0' })
	quantity?: number | null;

	@ApiPropertyOptional({ description: 'Rama c (mes cerrado): unitario mensual del REACTIVATION (default: el anterior)' })
	@ValidateIf((_item: ReactivateItemDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Precio inválido' })
	@Min(0.000001, { message: 'El precio debe ser mayor que 0' })
	unit_price?: number | null;
}

/** `contract_cancel` (§9.3.1): decisión por factura listada en `invoice_decisions_required` del preview. */
export class InvoiceDecisionDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Factura inválida' })
	invoice_id!: string;

	@ApiProperty({ enum: INVOICE_DECISION_ACTIONS, description: 'Por Emitir: emit | cancel. Emitida: keep | void' })
	@IsIn(INVOICE_DECISION_ACTIONS, { message: 'Acción inválida: emit, cancel, keep o void' })
	action!: InvoiceDecisionAction;
}

/** `change_entity` (§9.3.10): razón social nueva (se busca por identificador tributario normalizado en el holding antes de crearla). */
export class NewEntityDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'Escribe la razón social' })
	@MaxLength(300)
	legal_name!: string;

	@ApiProperty({ description: 'Identificador tributario (RUT, NIT, RFC…)' })
	@Transform(trim)
	@IsString({ message: 'Escribe el identificador tributario' })
	@MaxLength(40)
	tax_id!: string;

	@ApiProperty({ example: 'Chile' })
	@Transform(trim)
	@IsString({ message: 'Escribe el país' })
	@MaxLength(80)
	country!: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Dirección inválida' })
	@MaxLength(500)
	@IsOptional()
	address?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Correo inválido' })
	@MaxLength(200)
	@IsOptional()
	email?: string;

	@ApiPropertyOptional({ type: PaymentTermsDto })
	@ValidateIf((_entity: NewEntityDto, value: unknown) => present(value))
	@IsObject({ message: 'Condición de pago inválida' })
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	payment_terms?: PaymentTermsDto | null;
}

/** `renewal` (§9.3.4): qué hacer con cada pacto `on_renewal` del ítem (default: se aplica con su valor). */
export class ScheduledChangeDecisionDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Pacto inválido' })
	scheduled_change_id!: string;

	@ApiProperty({ enum: ['apply', 'skip'] })
	@IsIn(['apply', 'skip'], { message: 'Acción inválida: apply o skip' })
	action!: 'apply' | 'skip';

	@ApiPropertyOptional({ description: 'apply: valor a usar en vez del pactado (queda en `applied_value`)' })
	@ValidateIf((_decision: ScheduledChangeDecisionDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Valor inválido' })
	value?: number | null;

	@ApiPropertyOptional({ description: 'skip: motivo (obligatorio)' })
	@Transform(trim)
	@IsString({ message: 'Motivo inválido' })
	@MaxLength(500)
	@IsOptional()
	reason?: string;
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
	@ApiPropertyOptional({
		description:
			'Ítems según el tipo (ItemChangeItemDto | ItemAddItemDto | ItemRefDto | RenewalItemDto | ReactivateItemDto; pause/resume: ItemRefDto, sin lista = todos los recurrentes vivos / pausados)',
	})
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

	@ApiPropertyOptional({
		type: [FxPairRateDto],
		description:
			'billing_conditions e item_add: tasas fijas moneda del ítem (`from_currency`, default la del contrato) → moneda de factura; se agregan a las guardadas. En multimoneda, `from_currency` es obligatorio con más de una moneda de ítem',
	})
	@IsArray({ message: 'fx_invoice_rates debe ser una lista' })
	@ArrayMaxSize(FX_RATES_MAX)
	@ValidateNested({ each: true })
	@Type(() => FxPairRateDto)
	@IsOptional()
	fx_invoice_rates?: FxPairRateDto[];

	// ---- multimoneda (item_add, multicurrency)
	@ApiPropertyOptional({
		type: [FxItemRateDto],
		description: 'item_add multimoneda: tasas pactadas ítem → contrato (`purpose = item`) de las monedas nuevas; se agregan a las guardadas',
	})
	@IsArray({ message: 'fx_item_rates debe ser una lista' })
	@ArrayMaxSize(FX_RATES_MAX)
	@ValidateNested({ each: true })
	@Type(() => FxItemRateDto)
	@IsOptional()
	fx_item_rates?: FxItemRateDto[];

	@ApiPropertyOptional({
		description:
			'item_add: enciende multimoneda en la misma transacción, antes de insertar los ítems (queda en el evento del alta: `metadata.multicurrency_enabled`)',
	})
	@IsBoolean({ message: 'enable_multicurrency debe ser true o false' })
	@IsOptional()
	enable_multicurrency?: boolean;

	@ApiPropertyOptional({ description: 'multicurrency: true enciende, false apaga (bloqueado con ítems en otra moneda)' })
	@IsBoolean({ message: 'enabled debe ser true o false' })
	@IsOptional()
	enabled?: boolean;

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

	@ApiPropertyOptional({
		type: NewEntityDto,
		description:
			'change_entity (§9.3.10), en vez de client_entity_id: se busca por identificador tributario en el holding (del cliente → se usa con aviso entity_already_exists; de otro cliente → blocker entity_belongs_to_other_client); si no existe se crea ligada al cliente (is_primary = false)',
	})
	@ValidateIf((_change: ContractChangeDto, value: unknown) => present(value))
	@IsObject({ message: 'Razón social nueva inválida' })
	@ValidateNested()
	@Type(() => NewEntityDto)
	new_entity?: NewEntityDto | null;

	// ---- contract_cancel
	@ApiPropertyOptional({
		type: [InvoiceDecisionDto],
		description:
			'contract_cancel (§9.3.1) y pause (§9.3.3): una decisión por factura de `invoice_decisions_required` del preview (Por Emitir: emit | cancel; Emitida: keep | void). Si falta alguna → blocker invoice_decision_required',
	})
	@IsArray({ message: 'invoice_decisions debe ser una lista' })
	@ArrayMaxSize(500)
	@ValidateNested({ each: true })
	@Type(() => InvoiceDecisionDto)
	@IsOptional()
	invoice_decisions?: InvoiceDecisionDto[];

	// ---- billing_conditions: auto-renovación (§9.3.5)
	@ApiPropertyOptional({
		description:
			'billing_conditions (§9.3.5): enciende (true) o apaga (false) `auto_renew` en los ítems recurrentes vivos del contrato (sin baja ni renovación). Apagado, el job contracts-auto-renewal no los propone',
	})
	@IsBoolean({ message: 'auto_renew debe ser true o false' })
	@IsOptional()
	auto_renew?: boolean;

	// ---- pause / resume (§9.3.3)
	@ApiPropertyOptional({ example: '2026-11-01', description: 'pause: primer día pausado (default: effective_date)' })
	@Matches(ISO_DATE, { message: 'Inicio de la pausa inválido (YYYY-MM-DD)' })
	@IsOptional()
	pause_start?: string;

	@ApiPropertyOptional({ example: '2027-01-31', nullable: true, description: 'pause: último día pausado; null/ausente = hasta reanudar' })
	@ValidateIf((_change: ContractChangeDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'Fin de la pausa inválido (YYYY-MM-DD)' })
	pause_end?: string | null;

	@ApiPropertyOptional({
		default: false,
		description: 'pause: al terminar la pausa el fin del ítem se corre en los días pausados (con fin conocido, en el acto; abierta, al reanudar)',
	})
	@IsBoolean({ message: 'extend_term debe ser true o false' })
	@IsOptional()
	extend_term?: boolean;

	@ApiPropertyOptional({
		example: '2027-02-01',
		description: 'resume: primer día con servicio (default: effective_date); la pausa termina el día anterior',
	})
	@Matches(ISO_DATE, { message: 'Fecha de reanudación inválida (YYYY-MM-DD)' })
	@IsOptional()
	resume_date?: string;

	// ---- renewal (pactos on_renewal, §9.3.4)
	@ApiPropertyOptional({
		type: [ScheduledChangeDecisionDto],
		description: 'renewal: aplicar (default, con valor opcional) u omitir con motivo cada pacto `on_renewal` de los ítems renovados',
	})
	@IsArray({ message: 'scheduled_change_decisions debe ser una lista' })
	@ArrayMaxSize(200)
	@ValidateNested({ each: true })
	@Type(() => ScheduledChangeDecisionDto)
	@IsOptional()
	scheduled_change_decisions?: ScheduledChangeDecisionDto[];
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
