import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
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
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { PaymentTermsDto } from '@/modules/clients/dtos/client-directory.dto';
import { BILLING_FREQUENCIES, BILLING_METHODS, type BillingFrequency, type BillingMethod } from '@/modules/contracts/billing-engine';
import { hasPricingModel, PRICE_ENTRY_MODES, PriceSpecDto } from '@/modules/contracts/dtos/create-contract.dto';

import { QUOTE_TYPE_CODES, type QuoteTypeCode } from '../quote-status';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY = /^[A-Z]{2,4}$/;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Ítem de `CreateQuoteDto` (mapa §5d paso 2). Misma forma que el ítem de contrato: precio `standard` fijo (unitario mensual o
 * anual) o `price: PriceSpec` (tramos, paquete, asientos, medido) o `price_id` de catálogo (copia). Límites de texto = columnas de
 * `quote_items` (varchar 64/32/128).
 */
export class CreateQuoteItemDto {
	@ApiPropertyOptional({ description: 'Identificador del ítem en el formulario; vuelve como `item_key` en la vista previa' })
	@IsString({ message: 'Ítem inválido' })
	@MinLength(1, { message: 'Ítem inválido' })
	@MaxLength(64, { message: 'Ítem inválido' })
	@IsOptional()
	key?: string;

	@ApiProperty({ description: 'Producto del catálogo (obligatorio)' })
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

	@ApiPropertyOptional({ description: 'Precio unitario mensual. Obligatorio salvo con price_entry_mode annual, `price` o `price_id`' })
	@ValidateIf(
		(item: CreateQuoteItemDto) =>
			(item.price_entry_mode !== 'annual' && !hasPricingModel(item) && !item.price_id) || item.unit_price !== undefined
	)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio unitario' })
	@Min(0, { message: 'El precio no puede ser negativo' })
	unit_price?: number;

	@ApiPropertyOptional({ description: 'Precio unitario anual (con price_entry_mode annual)' })
	@ValidateIf((item: CreateQuoteItemDto) => item.price_entry_mode === 'annual' || item.annual_unit_price !== undefined)
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el precio anual' })
	@Min(0, { message: 'El precio anual no puede ser negativo' })
	annual_unit_price?: number;

	@ApiPropertyOptional({ enum: PRICE_ENTRY_MODES, default: 'monthly' })
	@IsIn(PRICE_ENTRY_MODES, { message: 'Modo de precio inválido' })
	@IsOptional()
	price_entry_mode?: (typeof PRICE_ENTRY_MODES)[number];

	@ApiPropertyOptional({
		type: PriceSpecDto,
		description: 'Pricing v2: modelo de precio inline (se guarda en `prices` con owner = quote y el ítem lo apunta). Sin él, standard fijo',
	})
	@ValidateIf((_item: CreateQuoteItemDto, value: unknown) => value !== null && value !== undefined)
	@ValidateNested()
	@Type(() => PriceSpecDto)
	price?: PriceSpecDto | null;

	@ApiPropertyOptional({
		description: 'Precio de catálogo (`prices.owner = catalog`, activo, del producto): se copia al ítem como precio negociado',
	})
	@IsUUID(undefined, { message: 'Precio de catálogo inválido' })
	@IsOptional()
	price_id?: string;

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

	@ApiProperty({ description: 'Plazo en meses; el fin es siempre inicio + plazo − 1 día' })
	@IsInt({ message: 'El plazo va en meses enteros' })
	@Min(1, { message: 'El plazo mínimo es 1 mes' })
	@Max(600, { message: 'El plazo máximo es 600 meses' })
	term_months!: number;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'Indica si el ítem es recurrente' })
	@IsOptional()
	is_recurring?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Propuesta: al crear el contrato lo desmarcado se respeta (Q-D5)' })
	@IsBoolean({ message: 'Auto-renovación inválida' })
	@IsOptional()
	auto_renew?: boolean;

	@ApiPropertyOptional()
	@IsInt({ message: 'El plazo de renovación va en meses enteros' })
	@Min(1, { message: 'El plazo de renovación mínimo es 1 mes' })
	@Max(120, { message: 'El plazo de renovación máximo es 120 meses' })
	@IsOptional()
	auto_renew_term_months?: number;

	@ApiPropertyOptional({ type: Object })
	@IsObject({ message: 'Campos personalizados inválidos' })
	@IsOptional()
	custom_fields?: Record<string, unknown>;
}

/** Body de `POST /quotes` y `POST /quotes/preview` (mapa §6). El holding sale de `HoldingScopeGuard`, nunca del body. */
export class CreateQuoteDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Elige un cliente' })
	client_id!: string;

	@ApiPropertyOptional({ description: 'Contacto del cliente' })
	@IsUUID(undefined, { message: 'Contacto inválido' })
	@IsOptional()
	client_contact_id?: string;

	@ApiPropertyOptional({ description: 'Vendedor del holding' })
	@IsUUID(undefined, { message: 'Vendedor inválido' })
	@IsOptional()
	seller_id?: string;

	@ApiProperty({ enum: QUOTE_TYPE_CODES, description: 'Tipo de negocio (catálogo Q-A9)' })
	@IsIn(QUOTE_TYPE_CODES, { message: 'Elige el tipo de negocio' })
	quote_type!: QuoteTypeCode;

	@ApiPropertyOptional({ example: '2026-10-01', description: 'Default: hoy' })
	@Matches(ISO_DATE, { message: 'Fecha de cotización inválida' })
	@IsOptional()
	quote_date?: string;

	@ApiPropertyOptional({ example: '2026-10-31', description: 'Válida hasta (Q-A2). Default: fecha + 30 días; null = sin vencimiento' })
	@ValidateIf((_dto: CreateQuoteDto, value: unknown) => value !== null && value !== undefined)
	@Matches(ISO_DATE, { message: 'Fecha de vigencia inválida' })
	valid_until?: string | null;

	@ApiPropertyOptional({ description: 'Fecha de cierre del negocio (obligatoria al marcar firmada, Q-D6)' })
	@ValidateIf((_dto: CreateQuoteDto, value: unknown) => value !== null && value !== undefined)
	@Matches(ISO_DATE, { message: 'Fecha de cierre inválida' })
	booking_date?: string | null;

	@ApiProperty({ example: 'USD' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Elige la moneda de la cotización' })
	currency!: string;

	@ApiPropertyOptional({
		type: PaymentTermsDto,
		description: 'Condición de pago estructurada (Q-D4); default: la de la razón social principal del cliente',
	})
	@ValidateIf((_dto: CreateQuoteDto, value: unknown) => value !== null && value !== undefined)
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	payment_terms?: PaymentTermsDto | null;

	@ApiPropertyOptional({ description: 'Texto de la condición de pago (front viejo y SF); default: derivado de `payment_terms`' })
	@Transform(trim)
	@IsString({ message: 'Condición de pago inválida' })
	@MaxLength(120, { message: 'Condición de pago: máximo 120 caracteres' })
	@IsOptional()
	payment_terms_text?: string;

	@ApiPropertyOptional({ description: 'Número manual; si se omite, correlativo COT-{año}-{NNNN}' })
	@Transform(trim)
	@IsString({ message: 'Número de cotización inválido' })
	@MinLength(1, { message: 'Escribe el número' })
	@MaxLength(40, { message: 'Número: máximo 40 caracteres' })
	@Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, { message: 'El número solo admite letras, números, punto, guion, barra y guion bajo' })
	@IsOptional()
	quote_number?: string;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(5000, { message: 'Las notas no pueden superar 5.000 caracteres' })
	@IsOptional()
	notes?: string;

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'Valor inválido' })
	@IsOptional()
	requires_multicompany?: boolean;

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'Valor inválido' })
	@IsOptional()
	requires_multicurrency?: boolean;

	@ApiPropertyOptional({ default: false, description: 'Requiere OC/HES para facturar (gate A11)' })
	@IsBoolean({ message: 'Valor inválido' })
	@IsOptional()
	requires_references_for_billing?: boolean;

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'Valor inválido' })
	@IsOptional()
	requires_contract_document?: boolean;

	@ApiProperty({ type: [CreateQuoteItemDto] })
	@IsArray({ message: 'Agrega al menos un ítem' })
	@ArrayMinSize(1, { message: 'Agrega al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por cotización' })
	@ValidateNested({ each: true })
	@Type(() => CreateQuoteItemDto)
	items!: CreateQuoteItemDto[];
}

/** Ítem de `PUT /quotes/:id`: con `id` actualiza el ítem existente (conserva el id que referencian los contratos); sin `id` lo crea. */
export class UpdateQuoteItemDto extends CreateQuoteItemDto {
	@ApiPropertyOptional({
		description: 'Ítem existente (`GET /quotes/:id/form`). Los ítems que no vengan se eliminan (409 si un contrato los referencia)',
	})
	@IsUUID(undefined, { message: 'Ítem de cotización inválido' })
	@IsOptional()
	id?: string;
}

/** Body de `PUT /quotes/:id` (solo `draft`/`sent` sin contrato): el formulario completo. `quote_number` no cambia al editar. */
export class UpdateQuoteDto extends CreateQuoteDto {
	@ApiProperty({ type: [UpdateQuoteItemDto] })
	@IsArray({ message: 'Agrega al menos un ítem' })
	@ArrayMinSize(1, { message: 'Agrega al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por cotización' })
	@ValidateNested({ each: true })
	@Type(() => UpdateQuoteItemDto)
	items!: UpdateQuoteItemDto[];
}

/** Body de `POST /quotes/:id/duplicate`. */
export class DuplicateQuoteDto {
	@ApiPropertyOptional({ example: '2026-10-01', description: 'Fecha de la copia; default: hoy' })
	@Matches(ISO_DATE, { message: 'Fecha de cotización inválida' })
	@IsOptional()
	quote_date?: string;
}
