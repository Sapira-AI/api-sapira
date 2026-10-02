/**
 * Filas de `contract_scheduled_changes` (spec modificaciones §9.3.6, §9.4 #1): lectura, forma del DTO, validación e INSERT. Módulo hoja
 * (sin importar los planes de modificación) para que lo usen el detalle del contrato, el alta de borradores y el CRUD sin ciclos.
 */

import { BILLING_FREQUENCY_MONTHS, type BillingFrequency } from './billing-engine';

import type { CreateScheduledChangeDto } from './dtos/contract-scheduled-changes.dto';
import type { CodedFieldError } from './multicurrency';
import type { QueryRunner } from 'typeorm';

type Row = Record<string, unknown>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** Fila de `contract_scheduled_changes` tal como la lee el plan de modificaciones. */
export interface ScheduledChangeRow {
	id: string;
	contract_item_id: string | null;
	group_key: string | null;
	parent_id: string | null;
	trigger: 'on_renewal' | 'on_date' | 'every_n_months';
	effective_date: string | null;
	anchor_date: string | null;
	interval_months: number | null;
	next_effective_date: string | null;
	kind: 'percent_uplift' | 'index' | 'new_unit_price' | 'quantity' | 'term' | 'billing_frequency';
	value: number;
	index_code: string | null;
	index_base_date: string | null;
	index_base_value: number | null;
	index_lag_months: number;
	rounding: 'none' | 'unit_2' | 'unit_0' | 'monthly_0';
	status: 'scheduled' | 'applied' | 'skipped' | 'cancelled';
}

/** Frecuencia (texto) de un número de meses (`kind = billing_frequency`: valor = meses). */
export const frequencyOfMonths = (months: number): BillingFrequency | null =>
	(Object.entries(BILLING_FREQUENCY_MONTHS).find(([, value]) => value === Math.round(months))?.[0] as BillingFrequency | undefined) ?? null;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const isoDate = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : (toText(value)?.slice(0, 10) ?? null));
const isoTime = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const REMOVAL_CATEGORIES = new Set(['CHURN', 'DOWNSELL']);

export const SCHEDULED_CHANGE_CODES = {
	not_editable: 'scheduled_change_not_editable',
	not_found: 'scheduled_change_not_found',
	contract_not_open: 'scheduled_change_contract_not_open',
} as const;

/** Pacto tal como lo devuelve la API (`GET /contracts/:id/scheduled-changes`, detalle del contrato). */
export interface ScheduledChangeView extends ScheduledChangeRow {
	contract_id: string;
	product_name: string | null;
	status_reason: string | null;
	status_changed_by: string | null;
	applied_event_id: string | null;
	applied_at: string | null;
	applied_value: number | null;
	origin: Record<string, unknown>;
	notes: string | null;
	created_by: string | null;
	created_at: string | null;
	updated_at: string | null;
}

export const SCHEDULED_CHANGE_SELECT = `SELECT sc.id, sc.contract_id, sc.contract_item_id, sc.group_key, sc.parent_id, sc.trigger,
		sc.effective_date::text AS effective_date, sc.anchor_date::text AS anchor_date, sc.interval_months,
		sc.next_effective_date::text AS next_effective_date, sc.kind, sc.value, sc.index_code, sc.index_base_date::text AS index_base_date,
		sc.index_base_value, sc.index_lag_months, sc.rounding, sc.status, sc.status_reason, sc.status_changed_by, sc.applied_event_id,
		sc.applied_at, sc.applied_value, sc.origin, sc.notes, sc.created_by, sc.created_at, sc.updated_at, ci.product_name
	FROM contract_scheduled_changes sc
	LEFT JOIN contract_items ci ON ci.id = sc.contract_item_id`;

export function rowToScheduledChange(row: Row): ScheduledChangeView {
	const origin =
		typeof row.origin === 'string' ? (JSON.parse(row.origin) as Record<string, unknown>) : ((row.origin as Record<string, unknown>) ?? {});

	return {
		id: String(row.id),
		contract_id: String(row.contract_id),
		contract_item_id: toText(row.contract_item_id),
		product_name: toText(row.product_name),
		group_key: toText(row.group_key),
		parent_id: toText(row.parent_id),
		trigger: String(row.trigger) as ScheduledChangeRow['trigger'],
		effective_date: isoDate(row.effective_date),
		anchor_date: isoDate(row.anchor_date),
		interval_months: toNullableNumber(row.interval_months),
		next_effective_date: isoDate(row.next_effective_date),
		kind: String(row.kind) as ScheduledChangeRow['kind'],
		value: toNumber(row.value),
		index_code: toText(row.index_code),
		index_base_date: isoDate(row.index_base_date),
		index_base_value: toNullableNumber(row.index_base_value),
		index_lag_months: row.index_lag_months === null || row.index_lag_months === undefined ? 1 : toNumber(row.index_lag_months),
		rounding: (toText(row.rounding) ?? 'unit_2') as ScheduledChangeRow['rounding'],
		status: (toText(row.status) ?? 'scheduled') as ScheduledChangeRow['status'],
		status_reason: toText(row.status_reason),
		status_changed_by: toText(row.status_changed_by),
		applied_event_id: toText(row.applied_event_id),
		applied_at: isoTime(row.applied_at),
		applied_value: toNullableNumber(row.applied_value),
		origin,
		notes: toText(row.notes),
		created_by: toText(row.created_by),
		created_at: isoTime(row.created_at),
		updated_at: isoTime(row.updated_at),
	};
}

/** Pactos del contrato (todos los estados), ordenados por próxima fecha y creación. */
export async function loadScheduledChanges(db: Queryable, contractId: string, holdingId: string): Promise<ScheduledChangeView[]> {
	const rows = (await db.query(
		`${SCHEDULED_CHANGE_SELECT}
		WHERE sc.contract_id = $1 AND sc.holding_id = $2
		ORDER BY COALESCE(sc.next_effective_date, sc.effective_date) NULLS LAST, sc.created_at, sc.id`,
		[contractId, holdingId]
	)) as Row[];

	return (rows ?? []).map(rowToScheduledChange);
}

/** Pacto guardado → forma del DTO (formulario del borrador: `item_key` = id del ítem). */
export function scheduledChangeToDto(view: ScheduledChangeView): CreateScheduledChangeDto {
	return {
		...(view.contract_item_id ? { item_key: view.contract_item_id } : {}),
		...(view.group_key ? { group_key: view.group_key } : {}),
		trigger: view.trigger,
		effective_date: view.effective_date,
		anchor_date: view.anchor_date,
		interval_months: view.interval_months,
		kind: view.kind,
		value: view.value,
		index_code: view.index_code,
		index_base_date: view.index_base_date,
		index_base_value: view.index_base_value,
		index_lag_months: view.index_lag_months,
		rounding: view.rounding,
		notes: view.notes,
	};
}

/** Ítem al que puede apuntar un pacto (alta: del formulario; CRUD: de la base). */
export interface PactItemRef {
	id: string;
	product_name: string | null;
	is_recurring: boolean;
	churn_date?: string | null;
	renewed_by_item_id?: string | null;
	categoria?: string | null;
}

/**
 * Reglas de un pacto (400 por campo): campos según disparo y tipo, valores en rango y el ítem del contrato (recurrente, sin baja ni
 * renovación). `itemId` = ítem ya resuelto (id o `item_key`), o null = alcance contrato.
 */
export function scheduledChangeErrors(
	dto: CreateScheduledChangeDto,
	field: string,
	item: PactItemRef | null,
	itemRequested: boolean
): CodedFieldError[] {
	const errors: CodedFieldError[] = [];
	const value = Number(dto.value);

	if (itemRequested && !item) errors.push({ field: `${field}.contract_item_id`, message: 'El ítem no pertenece al contrato' });
	if (item && item.is_recurring === false) errors.push({ field: `${field}.contract_item_id`, message: `"${item.product_name}" no es recurrente` });
	if (item && (item.churn_date || REMOVAL_CATEGORIES.has(item.categoria ?? '')))
		errors.push({ field: `${field}.contract_item_id`, message: `"${item.product_name}" tiene una baja registrada` });
	if (item && item.renewed_by_item_id)
		errors.push({ field: `${field}.contract_item_id`, message: `"${item.product_name}" ya fue renovado: pacta sobre el ítem de la renovación` });
	if (dto.trigger === 'on_date' && !dto.effective_date) errors.push({ field: `${field}.effective_date`, message: 'Indica la fecha del pacto' });
	if (dto.trigger === 'every_n_months') {
		if (!dto.anchor_date) errors.push({ field: `${field}.anchor_date`, message: 'Indica desde cuándo se repite el pacto' });
		if (!(Number(dto.interval_months) > 0)) errors.push({ field: `${field}.interval_months`, message: 'Indica cada cuántos meses se repite' });
	}
	if (dto.kind === 'index') {
		if (!dto.index_code?.trim()) errors.push({ field: `${field}.index_code`, message: 'Indica el índice (IPC, UF…)' });
		if (!(Number(dto.index_base_value) > 0)) errors.push({ field: `${field}.index_base_value`, message: 'Indica el valor base del índice' });
	}
	if (!Number.isFinite(value)) errors.push({ field: `${field}.value`, message: 'Escribe el valor del pacto' });
	else if ((dto.kind === 'quantity' || dto.kind === 'new_unit_price') && value <= 0)
		errors.push({
			field: `${field}.value`,
			message: dto.kind === 'quantity' ? 'La cantidad debe ser mayor que 0' : 'El precio debe ser mayor que 0',
		});
	else if (dto.kind === 'percent_uplift' && value <= -100)
		errors.push({ field: `${field}.value`, message: 'El porcentaje debe ser mayor que −100' });
	else if (dto.kind === 'term' && (!Number.isInteger(value) || value < 1 || value > 120))
		errors.push({ field: `${field}.value`, message: 'El plazo va en meses enteros (1 a 120)' });
	else if (dto.kind === 'billing_frequency' && !frequencyOfMonths(value))
		errors.push({
			field: `${field}.value`,
			message: `La frecuencia va en meses: ${Object.values(BILLING_FREQUENCY_MONTHS).join(', ')}`,
		});
	if ((dto.kind === 'term' || dto.kind === 'billing_frequency') && dto.trigger === 'every_n_months')
		errors.push({ field: `${field}.trigger`, message: 'Un cambio de plazo o frecuencia no se repite: usa on_renewal u on_date' });

	return errors;
}

/** Próxima fecha de aplicación al crear: `on_date` = su fecha; `every_n_months` = `anchor_date`; `on_renewal` = null (la renovación). */
export const nextEffectiveOf = (dto: Pick<CreateScheduledChangeDto, 'trigger' | 'effective_date' | 'anchor_date'>): string | null =>
	dto.trigger === 'on_date' ? (dto.effective_date ?? null) : dto.trigger === 'every_n_months' ? (dto.anchor_date ?? null) : null;

/** INSERT de un pacto (`status` default `scheduled`). Devuelve el id. */
export async function insertScheduledChange(
	runner: Pick<QueryRunner, 'query'>,
	input: {
		contract_id: string;
		holding_id: string;
		contract_item_id: string | null;
		dto: CreateScheduledChangeDto;
		user_id: string | null;
		origin?: Record<string, unknown>;
	}
): Promise<string> {
	const { dto } = input;
	const [row] = (await runner.query(
		`INSERT INTO contract_scheduled_changes (
			holding_id, contract_id, contract_item_id, group_key, trigger, effective_date, anchor_date, interval_months, next_effective_date,
			kind, value, index_code, index_base_date, index_base_value, index_lag_months, rounding, status, origin, notes, created_by
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'scheduled', $17::jsonb, $18, $19) RETURNING id`,
		[
			input.holding_id,
			input.contract_id,
			input.contract_item_id,
			dto.group_key ?? null,
			dto.trigger,
			dto.effective_date ?? null,
			dto.anchor_date ?? null,
			dto.interval_months ?? null,
			nextEffectiveOf(dto),
			dto.kind,
			dto.value,
			dto.index_code ?? null,
			dto.index_base_date ?? null,
			dto.index_base_value ?? null,
			dto.index_lag_months ?? 1,
			dto.rounding ?? 'unit_2',
			JSON.stringify(input.origin ?? { type: 'manual' }),
			dto.notes ?? null,
			input.user_id,
		]
	)) as Row[];

	return String(row.id);
}

/** Alta del borrador: errores de `scheduled_changes[]` contra los ítems del formulario (por `item_key`). */
export function draftScheduledChangeErrors(
	pacts: CreateScheduledChangeDto[] | undefined,
	items: Array<{ key: string; id?: string | null; product_name: string; is_recurring: boolean }>
): CodedFieldError[] {
	return (pacts ?? []).flatMap((pact, index) => {
		const ref = pact.item_key ?? pact.contract_item_id ?? null;
		const item = ref ? items.find((row) => row.key === ref || (row.id && row.id === ref)) : null;

		return scheduledChangeErrors(
			pact,
			`scheduled_changes.${index}`,
			item ? { id: item.key, product_name: item.product_name, is_recurring: item.is_recurring } : null,
			Boolean(ref)
		);
	});
}
