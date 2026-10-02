import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsEmail,
	IsIn,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';

import {
	ErpResetInvoicesBulkDto,
	INVOICE_IDS_MAX,
	InvoiceFxBulkDto,
	InvoiceOperationDto,
	RescheduleInvoicesBulkDto,
} from '@/modules/contracts/dtos/contract-invoices.dto';

import {
	CALENDAR_GRANULARITIES,
	CALENDAR_GROUP_BY,
	CALENDAR_SCOPES,
	type CalendarGranularity,
	type CalendarGroupBy,
	type CalendarScope,
} from '../billing-calendar';
import {
	CHARGE_STATES,
	CREDIT_TYPES,
	DOCUMENT_KINDS,
	ELECTRONIC_STATES,
	ERP_STATES,
	INVOICE_SOURCES,
	INVOICE_STATUSES,
	PAYMENT_STATES,
	TO_ISSUE_GROUPS,
} from '../billing-states';

const UUID_LIST =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY_LIST = /^[A-Za-z]{3}(,[A-Za-z]{3}){0,19}$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (values: readonly string[]) => new RegExp(`^(${values.map(escape).join('|')})(,(${values.map(escape).join('|')})){0,9}$`);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export const INVOICE_SORT_FIELDS = [
	'issue_date',
	'due_date',
	'invoice_number',
	'client_name',
	'contract_number',
	'company_name',
	'status',
	'total_invoice_currency',
	'balance',
	'created_at',
] as const;
export type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];

/**
 * Filtros comunes de `/billing/*` (spec-facturacion-v2 §5.1). Listas separadas por coma. El holding sale de `HoldingScopeGuard`, nunca de la
 * query. Sin `status`, la lista excluye Canceladas (`include_cancelled=true` las suma); los orígenes consolidados (inactivos) solo con
 * `include_inactive=true`.
 */
export class BillingFiltersDto {
	@ApiPropertyOptional({ description: 'Mes inicial YYYY-MM (por fecha de emisión o vencimiento según date_field)' })
	@Matches(MONTH, { message: 'from debe ser YYYY-MM' })
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ description: 'Mes final YYYY-MM (incluido)' })
	@Matches(MONTH, { message: 'to debe ser YYYY-MM' })
	@IsOptional()
	to?: string;

	@ApiPropertyOptional({ enum: ['issue', 'due'], default: 'issue' })
	@IsIn(['issue', 'due'], { message: 'date_field debe ser issue o due' })
	@IsOptional()
	date_field?: 'issue' | 'due';

	@ApiPropertyOptional({ description: `Estado (${INVOICE_STATUSES.join(', ')}); varios separados por coma` })
	@Matches(list(INVOICE_STATUSES), { message: `status debe ser uno o varios de: ${INVOICE_STATUSES.join(', ')}` })
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({ description: `Documento (${DOCUMENT_KINDS.join(', ')})` })
	@Matches(list(DOCUMENT_KINDS), { message: `document_kind debe ser uno o varios de: ${DOCUMENT_KINDS.join(', ')}` })
	@IsOptional()
	document_kind?: string;

	@ApiPropertyOptional({ description: `Estado ERP (${ERP_STATES.join(', ')})` })
	@Matches(list(ERP_STATES), { message: `erp_state debe ser uno o varios de: ${ERP_STATES.join(', ')}` })
	@IsOptional()
	erp_state?: string;

	@ApiPropertyOptional({ description: `Emisión electrónica (${ELECTRONIC_STATES.join(', ')})` })
	@Matches(list(ELECTRONIC_STATES), { message: `electronic_state debe ser uno o varios de: ${ELECTRONIC_STATES.join(', ')}` })
	@IsOptional()
	electronic_state?: string;

	@ApiPropertyOptional({ description: `Pago (${PAYMENT_STATES.join(', ')})` })
	@Matches(list(PAYMENT_STATES), { message: `payment_state debe ser uno o varios de: ${PAYMENT_STATES.join(', ')}` })
	@IsOptional()
	payment_state?: string;

	@ApiPropertyOptional({ description: 'Compañía emisora; varias separadas por coma' })
	@Matches(UUID_LIST, { message: 'company_id debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	company_id?: string;

	@ApiPropertyOptional({ description: 'Cliente; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'client_id debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional({ description: 'Razón social; varias separadas por coma' })
	@Matches(UUID_LIST, { message: 'client_entity_id debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	client_entity_id?: string;

	@ApiPropertyOptional({ description: 'Contrato' })
	@IsUUID(undefined, { message: 'contract_id debe ser un UUID' })
	@IsOptional()
	contract_id?: string;

	@ApiPropertyOptional({ description: 'Moneda de la factura (ISO 4217); varias separadas por coma' })
	@Matches(CURRENCY_LIST, { message: 'invoice_currency debe ser uno o varios códigos de 3 letras' })
	@IsOptional()
	invoice_currency?: string;

	@ApiPropertyOptional({ description: 'Solo Por Emitir con bloqueo (true) o sin bloqueo (false)' })
	@Transform(bool)
	@IsBoolean({ message: 'blocked debe ser true o false' })
	@IsOptional()
	blocked?: boolean;

	@ApiPropertyOptional({ description: 'Solo facturas con desvío registrado sin motivo' })
	@Transform(bool)
	@IsBoolean({ message: 'deviation_unexplained debe ser true o false' })
	@IsOptional()
	deviation_unexplained?: boolean;

	@ApiPropertyOptional({ description: 'Incluir Canceladas cuando no se filtra por estado' })
	@Transform(bool)
	@IsBoolean({ message: 'include_cancelled debe ser true o false' })
	@IsOptional()
	include_cancelled?: boolean;

	@ApiPropertyOptional({ description: 'Incluir inactivas (orígenes de una consolidación)' })
	@Transform(bool)
	@IsBoolean({ message: 'include_inactive debe ser true o false' })
	@IsOptional()
	include_inactive?: boolean;

	@ApiPropertyOptional({ description: 'Búsqueda: folio, cliente, razón social o contrato' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	q?: string;

	@ApiPropertyOptional({ description: `Origen (${INVOICE_SOURCES.join(', ')}); varios separados por coma. Sin él: todos` })
	@Matches(list(INVOICE_SOURCES), { message: `source debe ser uno o varios de: ${INVOICE_SOURCES.join(', ')}` })
	@IsOptional()
	source?: string;
}

class BillingPageDto extends BillingFiltersDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 50, maximum: 200 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200, { message: 'limit máximo 200' })
	@IsOptional()
	limit?: number;
}

export class BillingInvoicesQueryDto extends BillingPageDto {
	@ApiPropertyOptional({ enum: INVOICE_SORT_FIELDS, default: 'issue_date' })
	@IsIn(INVOICE_SORT_FIELDS, { message: `sortBy debe ser uno de: ${INVOICE_SORT_FIELDS.join(', ')}` })
	@IsOptional()
	sortBy?: InvoiceSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

export class BillingCreditNotesQueryDto extends BillingInvoicesQueryDto {
	@ApiPropertyOptional({ description: `Tipo de NC (${CREDIT_TYPES.join(', ')})` })
	@Matches(list(CREDIT_TYPES), { message: `credit_type debe ser uno o varios de: ${CREDIT_TYPES.join(', ')}` })
	@IsOptional()
	credit_type?: string;
}

/** Facturas de suscripción (Stripe): filtros comunes + orden + estado del cobro. */
export class BillingSubscriptionInvoicesQueryDto extends BillingInvoicesQueryDto {
	@ApiPropertyOptional({ description: `Estado del cobro (${CHARGE_STATES.join(', ')}); varios separados por coma` })
	@Matches(list(CHARGE_STATES), { message: `charge_state debe ser uno o varios de: ${CHARGE_STATES.join(', ')}` })
	@IsOptional()
	charge_state?: string;
}

export class BillingToIssueQueryDto extends BillingPageDto {
	@ApiPropertyOptional({ description: 'Emisión (o programación) hasta esta fecha YYYY-MM-DD (default: fin del mes en curso)' })
	@Matches(ISO_DATE, { message: 'until debe ser YYYY-MM-DD' })
	@IsOptional()
	until?: string;

	@ApiPropertyOptional({ enum: TO_ISSUE_GROUPS, description: 'Solo un grupo de la cola' })
	@IsIn(TO_ISSUE_GROUPS, { message: `group debe ser uno de: ${TO_ISSUE_GROUPS.join(', ')}` })
	@IsOptional()
	group?: (typeof TO_ISSUE_GROUPS)[number];

	@ApiPropertyOptional({ description: 'Solo las bloqueadas con este código' })
	@Matches(/^[a-z_]{2,60}$/, { message: 'blocker_code inválido' })
	@IsOptional()
	blocker_code?: string;
}

export class BillingAgingQueryDto {
	@ApiPropertyOptional({ description: 'Corte YYYY-MM-DD (default: hoy, America/Santiago)' })
	@Matches(ISO_DATE, { message: 'as_of debe ser YYYY-MM-DD' })
	@IsOptional()
	as_of?: string;

	@ApiPropertyOptional({ description: 'Compañía emisora; varias separadas por coma' })
	@Matches(UUID_LIST, { message: 'company_id debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	company_id?: string;

	@ApiPropertyOptional({ description: 'Cliente; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'client_id debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional({ description: 'Moneda de la factura (una)' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'currency debe ser un código de 3 letras' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ description: `Origen (${INVOICE_SOURCES.join(', ')}); Cobranza excluye suscripciones con contract,other` })
	@Matches(list(INVOICE_SOURCES), { message: `source debe ser uno o varios de: ${INVOICE_SOURCES.join(', ')}` })
	@IsOptional()
	source?: string;

	@ApiPropertyOptional({ enum: ['invoices'], description: 'Con `invoices`, agrega una fila por factura con saldo (reporte Cuentas por cobrar)' })
	@IsIn(['invoices'], { message: 'detail debe ser invoices' })
	@IsOptional()
	detail?: 'invoices';
}

/**
 * Calendario de facturación (`GET /billing/calendar`): filtros comunes (salvo `from`/`to`, que reemplaza el rango) + granularidad, rango y
 * alcance. `scope=to_issue` = la cola Por emitir (estado = grupo de la cola; las atrasadas antes del rango van en la columna `before`).
 */
export class BillingCalendarQueryDto extends BillingFiltersDto {
	@ApiPropertyOptional({ enum: CALENDAR_GRANULARITIES, default: 'month' })
	@IsIn(CALENDAR_GRANULARITIES, { message: `granularity debe ser uno de: ${CALENDAR_GRANULARITIES.join(', ')}` })
	@IsOptional()
	granularity?: CalendarGranularity;

	@ApiPropertyOptional({ description: 'Inicio del rango YYYY-MM-DD (default: hoy); se lleva al inicio de su mes, semana o día' })
	@Matches(ISO_DATE, { message: 'start debe ser YYYY-MM-DD' })
	@IsOptional()
	start?: string;

	@ApiPropertyOptional({ description: 'Fin del rango YYYY-MM-DD (default: 12 meses, 12 semanas o 21 días); máximo 24 meses, 26 semanas o 62 días' })
	@Matches(ISO_DATE, { message: 'end debe ser YYYY-MM-DD' })
	@IsOptional()
	end?: string;

	@ApiPropertyOptional({ enum: CALENDAR_SCOPES, default: 'invoices' })
	@IsIn(CALENDAR_SCOPES, { message: `scope debe ser uno de: ${CALENDAR_SCOPES.join(', ')}` })
	@IsOptional()
	scope?: CalendarScope;

	@ApiPropertyOptional({ enum: CALENDAR_GROUP_BY, default: 'client' })
	@IsIn(CALENDAR_GROUP_BY, { message: `group_by debe ser uno de: ${CALENDAR_GROUP_BY.join(', ')}` })
	@IsOptional()
	group_by?: CalendarGroupBy;
}

export class BillingExportQueryDto extends BillingFiltersDto {
	@ApiPropertyOptional({ enum: ['header', 'lines'], default: 'header' })
	@IsIn(['header', 'lines'], { message: 'detail debe ser header o lines' })
	@IsOptional()
	detail?: 'header' | 'lines';

	@ApiPropertyOptional({ enum: INVOICE_SORT_FIELDS, default: 'issue_date' })
	@IsIn(INVOICE_SORT_FIELDS)
	@IsOptional()
	sortBy?: InvoiceSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------- pagos

export class PaymentAllocationDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Factura inválida' })
	invoice_id!: string;

	@ApiProperty({ description: 'Monto en la moneda de la factura (> 0)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto inválido' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount!: number;
}

export class RegisterPaymentDto {
	@ApiProperty({ type: [PaymentAllocationDto], description: '1 a 100 facturas emitidas del mismo cliente y moneda' })
	@IsArray({ message: 'Indica las facturas del pago' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(100, { message: 'Máximo 100 facturas por pago' })
	@ValidateNested({ each: true })
	@Type(() => PaymentAllocationDto)
	allocations!: PaymentAllocationDto[];

	@ApiProperty({ description: 'Moneda del pago (debe ser la de las facturas)' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	currency!: string;

	@ApiProperty({ description: 'Fecha de pago YYYY-MM-DD' })
	@Matches(ISO_DATE, { message: 'La fecha de pago debe tener la forma YYYY-MM-DD' })
	payment_date!: string;

	@ApiPropertyOptional({ maxLength: 60 })
	@Transform(trim)
	@IsString()
	@MaxLength(60)
	@IsOptional()
	method?: string;

	@ApiPropertyOptional({ maxLength: 200 })
	@Transform(trim)
	@IsString()
	@MaxLength(200)
	@IsOptional()
	reference?: string;

	@ApiPropertyOptional({ maxLength: 2000 })
	@Transform(trim)
	@IsString()
	@MaxLength(2000)
	@IsOptional()
	notes?: string;
}

export class VoidPaymentDto {
	@ApiProperty({ description: 'Motivo de la anulación (queda en el evento)' })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@Matches(/\S/, { message: 'Escribe el motivo' })
	@MaxLength(500)
	reason!: string;
}

// ---------------------------------------------------------------- correos

export class ProformaDto {
	@ApiProperty({ type: [String], description: '1 a 10 destinatarios' })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un destinatario' })
	@ArrayMaxSize(10, { message: 'Máximo 10 destinatarios' })
	@IsEmail({}, { each: true, message: 'Correo inválido' })
	recipients!: string[];

	@ApiPropertyOptional({ maxLength: 200 })
	@Transform(trim)
	@IsString()
	@MaxLength(200)
	@IsOptional()
	subject?: string;

	@ApiPropertyOptional({ maxLength: 5000 })
	@Transform(trim)
	@IsString()
	@MaxLength(5000)
	@IsOptional()
	message?: string;

	@ApiPropertyOptional({ description: 'PDF de la proforma en base64 (el que dibuja `proforma-pdf.ts` del front), ≤ 5 MB' })
	@IsString()
	@MaxLength(7_000_000, { message: 'El PDF no puede superar 5 MB' })
	@Matches(/^[A-Za-z0-9+/=\s]+$/, { message: 'El PDF debe venir en base64' })
	@IsOptional()
	pdf_base64?: string;

	@ApiPropertyOptional({ description: 'Nombre del adjunto' })
	@Transform(trim)
	@Matches(/^[\w .\-()]{1,120}\.pdf$/i, { message: 'Nombre de archivo inválido (debe terminar en .pdf)' })
	@IsOptional()
	filename?: string;
}

export class CollectionDto {
	@ApiProperty({ type: [String], description: `Facturas (≤ ${INVOICE_IDS_MAX})` })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];

	@ApiProperty({ enum: ['entity_contacts', 'custom'] })
	@IsIn(['entity_contacts', 'custom'], { message: 'recipients_mode debe ser entity_contacts o custom' })
	recipients_mode!: 'entity_contacts' | 'custom';

	@ApiPropertyOptional({ type: [String], description: 'Obligatorio con custom (1 a 10)' })
	@IsArray()
	@ArrayMaxSize(10, { message: 'Máximo 10 destinatarios' })
	@IsEmail({}, { each: true, message: 'Correo inválido' })
	@IsOptional()
	recipients?: string[];

	@ApiPropertyOptional({ maxLength: 200, description: 'Asunto (default: plantilla del holding)' })
	@Transform(trim)
	@IsString()
	@MaxLength(200)
	@IsOptional()
	subject?: string;

	@ApiPropertyOptional({ maxLength: 5000, description: 'Mensaje (default: plantilla del holding)' })
	@Transform(trim)
	@IsString()
	@MaxLength(5000)
	@IsOptional()
	message?: string;
}

export class CollectionSettingsDto {
	@ApiProperty()
	@IsBoolean({ message: 'dunning_enabled debe ser true o false' })
	dunning_enabled!: boolean;

	@ApiProperty({ type: [Number], description: 'Días antes del vencimiento (0–90, máx. 10)' })
	@IsArray()
	@ArrayMaxSize(10)
	@IsInt({ each: true, message: 'Días inválidos' })
	@Min(1, { each: true, message: 'Mínimo 1 día' })
	@Max(90, { each: true, message: 'Máximo 90 días' })
	reminder_days_before!: number[];

	@ApiProperty({ type: [Number], description: 'Días después del vencimiento (1–180, máx. 10)' })
	@IsArray()
	@ArrayMaxSize(10)
	@IsInt({ each: true, message: 'Días inválidos' })
	@Min(1, { each: true, message: 'Mínimo 1 día' })
	@Max(180, { each: true, message: 'Máximo 180 días' })
	reminder_days_after!: number[];

	@ApiPropertyOptional({ description: 'Remitente (debe ser un remitente verificado del holding)' })
	@IsEmail({}, { message: 'Remitente inválido' })
	@IsOptional()
	email_from?: string | null;

	@ApiPropertyOptional({ description: 'Copia oculta (uno o varios correos separados por coma)' })
	@Transform(trim)
	@IsString()
	@MaxLength(500)
	@IsOptional()
	bcc?: string | null;

	@ApiProperty({ maxLength: 200 })
	@Transform(trim)
	@IsString()
	@Matches(/\S/, { message: 'Escribe el asunto' })
	@MaxLength(200)
	email_subject_template!: string;

	@ApiProperty({ maxLength: 5000 })
	@Transform(trim)
	@IsString()
	@Matches(/\S/, { message: 'Escribe el mensaje' })
	@MaxLength(5000)
	email_body_template!: string;
}

// ---------------------------------------------------------------- fan-out Por emitir (§5.2): mismo cuerpo que el endpoint del contrato

/** `POST /billing/to-issue/send-now[/preview]`: `send-now` del contrato por factura. */
export class ToIssueSendNowDto extends InvoiceOperationDto {
	@ApiProperty({ type: [String], description: `Facturas Por Emitir de uno o varios contratos (≤ ${INVOICE_IDS_MAX})` })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];
}

/** `POST /billing/to-issue/reschedule[/preview]`: `reschedule-bulk` del contrato por grupo. */
export class ToIssueRescheduleDto extends RescheduleInvoicesBulkDto {}

/** `POST /billing/to-issue/fx[/preview]`: `fx-bulk` del contrato por grupo. */
export class ToIssueFxDto extends InvoiceFxBulkDto {}

/** `POST /billing/to-issue/erp-reset`: `erp-reset` masivo del contrato por grupo (sin preview, como en el 360). */
export class ToIssueErpResetDto extends ErpResetInvoicesBulkDto {}
