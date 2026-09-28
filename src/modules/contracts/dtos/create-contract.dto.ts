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

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY = /^[A-Z]{2,4}$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Tasa fija por período, con la regla única "1 [moneda del contrato] = rate [otra moneda]" (se multiplica). Sin fechas,
 * cubre todo el contrato (del primer inicio al último fin de los ítems).
 */
export class FxRatePeriodDto {
	@ApiProperty({ description: '1 [moneda del contrato] = rate [moneda de factura o de la compañía]', example: 950 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la tasa (hasta 6 decimales)' })
	@Min(0.000001, { message: 'La tasa debe ser mayor que 0' })
	@Max(999999999, { message: 'Tasa fuera de rango' })
	rate!: number;

	@ApiPropertyOptional({ example: '2026-10-01', description: 'Default: primer inicio de los ítems' })
	@Matches(ISO_DATE, { message: 'Fecha de inicio de la tasa inválida' })
	@IsOptional()
	period_start?: string;

	@ApiPropertyOptional({ example: '2027-09-30', description: 'Default: último fin de los ítems' })
	@Matches(ISO_DATE, { message: 'Fecha de fin de la tasa inválida' })
	@IsOptional()
	period_end?: string;
}

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

	@ApiPropertyOptional({ description: 'Precio unitario mensual. Obligatorio salvo con price_entry_mode annual' })
	@ValidateIf((item: CreateContractItemDto) => item.price_entry_mode !== 'annual' || item.unit_price !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario' })
	@Min(0, { message: 'El precio no puede ser negativo' })
	unit_price?: number;

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

	@ApiProperty({ description: 'Plazo en meses' })
	@IsInt({ message: 'El plazo va en meses enteros' })
	@Min(1, { message: 'El plazo mínimo es 1 mes' })
	@Max(600, { message: 'El plazo máximo es 600 meses' })
	term_months!: number;

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
		description: 'Tasas fijas contrato → factura (al menos una con fx_invoice_policy fixed). `[{ rate }]` = una tasa para todo el contrato',
	})
	@ValidateIf((dto: CreateContractDto) => dto.fx_invoice_policy === 'fixed' || dto.fx_invoice_rates !== undefined)
	@ValidateNested({ each: true })
	@Type(() => FxRatePeriodDto)
	@ArrayMaxSize(FX_RATES_MAX, { message: `Máximo ${FX_RATES_MAX} tasas` })
	// class-validator informa primero el decorador de más abajo: "Agrega la tasa" cuando falta.
	@ArrayMinSize(1, { message: 'Agrega la tasa fija de facturación' })
	@IsArray({ message: 'Agrega la tasa fija de facturación' })
	fx_invoice_rates?: FxRatePeriodDto[];

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

	@ApiPropertyOptional({ enum: CONTRACT_DOCUMENT_TYPES, description: 'Default: sugerido por país emisor vs receptor' })
	@IsIn(CONTRACT_DOCUMENT_TYPES, { message: 'Tipo de documento inválido' })
	@IsOptional()
	document_type?: ContractDocumentType;

	@ApiPropertyOptional({ description: 'Día de ciclo 1–31; default: día del primer inicio de los recurrentes' })
	@IsInt({ message: 'Día de ciclo inválido' })
	@Min(1, { message: 'El día de ciclo va de 1 a 31' })
	@Max(31, { message: 'El día de ciclo va de 1 a 31' })
	@IsOptional()
	billing_anchor_day?: number;

	@ApiPropertyOptional({ default: true, description: 'true = ítems juntos por mes de emisión; false = una factura por ítem' })
	@IsBoolean({ message: 'Agrupación inválida' })
	@IsOptional()
	group_invoices_by_period?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Apagado por defecto (S6-10)' })
	@IsBoolean({ message: 'Envío automático a Odoo inválido' })
	@IsOptional()
	auto_send_to_odoo?: boolean;

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'Facturación automática inválida' })
	@IsOptional()
	auto_invoice?: boolean;

	@ApiPropertyOptional({ description: 'Fecha de cierre del negocio; default: la de la cotización (o se fija al activar)' })
	@Matches(ISO_DATE, { message: 'Fecha de cierre inválida' })
	@IsOptional()
	booking_date?: string;

	@ApiPropertyOptional({ description: 'Cotización firmada de origen' })
	@IsUUID(undefined, { message: 'Cotización inválida' })
	@IsOptional()
	quote_id?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Oportunidad inválida' })
	@MaxLength(40, { message: 'Oportunidad: máximo 40 caracteres' })
	@IsOptional()
	salesforce_opportunity_id?: string;

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

	@ApiProperty({ type: [CreateContractItemDto] })
	@IsArray({ message: 'Agrega al menos un ítem' })
	@ArrayMinSize(1, { message: 'Agrega al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por contrato' })
	@ValidateNested({ each: true })
	@Type(() => CreateContractItemDto)
	items!: CreateContractItemDto[];
}
