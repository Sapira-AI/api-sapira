/**
 * Unificación recurrente de facturas de una razón social (`docs/v2-rediseno/spec-unificacion-recurrente.md`): lógica pura, sin base.
 * Agrupa las Por Emitir de los contratos de la regla por mes y por lo que exige un mismo documento (compañía, moneda de factura,
 * documento, exportación y serie) y decide qué hacer con cada grupo. El servicio (`invoice-consolidation-rules.service.ts`) carga, arma el
 * plan con `planConsolidation` y escribe con la consolidación existente.
 */
import type { InvoiceBlocker } from './contract-invoices';

export const CONSOLIDATION_RULE_SOURCE = 'razon_social_360';
export const CONSOLIDATION_RULE_JOB_SOURCE = 'consolidation_rule_job';
export const CONSOLIDATION_RULE_UNDO_REASON = 'Se suma una factura nueva a la unificación recurrente de la razón social';
export const CONSOLIDATION_RULE_PAUSE_REASON = 'Unificación recurrente pausada';
export const CONSOLIDATION_RULE_MIN_CONTRACTS = 2;

/** Bloqueos propios de la regla (los de la consolidación vienen de `planConsolidation`). */
export const RULE_BLOCKERS = {
	unified_already_sent: {
		code: 'unified_already_sent',
		message: 'La factura unificada del mes ya salió al ERP: la factura nueva queda aparte',
		next_step: 'Factúrala por separado o anula y reemite la unificada',
	},
} as const;

/** Una Por Emitir de un contrato de la regla, tal como la necesita la agrupación. */
export interface RuleInvoice {
	id: string;
	contract_id: string;
	contract_number: string | null;
	company_id: string | null;
	invoice_currency: string | null;
	document_type: string | null;
	export_type: number;
	invoice_series: string | null;
	/** `YYYY-MM` de `COALESCE(issue_date, scheduled_at)`. */
	month: string;
	issue_date: string | null;
	total: number | null;
	/** Unificada que ya la contiene (origen inactivo), o null si está suelta. */
	consolidated_into_invoice_id: string | null;
}

/** Una unificada vigente (Por Emitir o ya emitida) armada con facturas de los contratos de la regla. */
export interface RuleUnified {
	id: string;
	invoice_number: string | null;
	status: string | null;
	issue_date: string | null;
	total: number | null;
	currency: string | null;
	/** Ya tiene borrador o envío al ERP: no se deshace para re-unificar. */
	sent_to_erp: boolean;
}

export type RuleGroupAction =
	/** Nada que hacer: ya unificado, sin facturas sueltas. */
	| 'unified'
	/** Unificar las sueltas (2 o más contratos). */
	| 'unify'
	/** Deshacer la unificada (sigue Por Emitir) y volver a armarla con la factura nueva. */
	| 'reunify'
	/** Un solo contrato con factura ese mes: no hay nada que unificar. */
	| 'single'
	/** La unificada ya salió al ERP y apareció una factura nueva del mes. */
	| 'blocked';

export interface RuleGroup {
	key: string;
	month: string;
	/** Facturas sueltas del grupo. */
	loose: RuleInvoice[];
	/** Orígenes de la unificada del grupo (si existe). */
	origins: RuleInvoice[];
	unified: RuleUnified | null;
	action: RuleGroupAction;
	blockers: InvoiceBlocker[];
	/** Facturas que entran a la consolidación (`unify`: sueltas; `reunify`: orígenes + sueltas). */
	to_consolidate: string[];
}

const groupKey = (invoice: RuleInvoice) =>
	[
		invoice.month,
		invoice.company_id ?? '',
		(invoice.invoice_currency ?? '').toUpperCase(),
		invoice.document_type || 'FACTURA',
		invoice.export_type ?? 0,
		invoice.invoice_series ?? '',
	].join('|');

/**
 * Agrupa por mes y documento y decide la acción de cada grupo. Una unificada se asigna al grupo de sus orígenes. Con unificada y sin
 * sueltas: `unified`; con sueltas: `reunify` si la unificada sigue Por Emitir sin ERP, `blocked` si ya salió; sin unificada: `unify` con 2
 * o más contratos, `single` con uno. Orden: por mes, luego por clave.
 */
export function planRuleGroups(invoices: RuleInvoice[], unifiedById: Map<string, RuleUnified>): RuleGroup[] {
	const groups = new Map<string, { loose: RuleInvoice[]; origins: RuleInvoice[]; unifiedIds: Set<string> }>();

	for (const invoice of invoices) {
		const key = groupKey(invoice);
		const group = groups.get(key) ?? { loose: [], origins: [], unifiedIds: new Set<string>() };

		if (invoice.consolidated_into_invoice_id) {
			group.origins.push(invoice);
			group.unifiedIds.add(invoice.consolidated_into_invoice_id);
		} else group.loose.push(invoice);
		groups.set(key, group);
	}

	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, group]) => {
			const month = key.split('|')[0];
			// Más de una unificada en el mismo grupo (armadas a mano): se toma la primera; las demás quedan como están.
			const unifiedId = [...group.unifiedIds][0] ?? null;
			const unified = unifiedId ? (unifiedById.get(unifiedId) ?? null) : null;
			const origins = unifiedId ? group.origins.filter((invoice) => invoice.consolidated_into_invoice_id === unifiedId) : [];
			const contracts = new Set(group.loose.map((invoice) => invoice.contract_id));
			const base = { key, month, loose: group.loose, origins, unified, blockers: [] as InvoiceBlocker[], to_consolidate: [] as string[] };

			if (unified && !group.loose.length) return { ...base, action: 'unified' as const };
			if (unified && group.loose.length) {
				if (unified.sent_to_erp || unified.status !== 'Por Emitir')
					return { ...base, action: 'blocked' as const, blockers: [{ ...RULE_BLOCKERS.unified_already_sent }] };

				return { ...base, action: 'reunify' as const, to_consolidate: [...origins, ...group.loose].map((invoice) => invoice.id) };
			}
			if (contracts.size >= CONSOLIDATION_RULE_MIN_CONTRACTS)
				return { ...base, action: 'unify' as const, to_consolidate: group.loose.map((invoice) => invoice.id) };

			return { ...base, action: 'single' as const };
		});
}

/** Día del mes en que emite un contrato: el de su próxima Por Emitir (desde hoy), o el de la última si no hay próximas. */
export function issueDayOf(dates: string[], today: string): number | null {
	const sorted = [...dates].filter(Boolean).sort();
	const next = sorted.find((date) => date >= today) ?? sorted.at(-1) ?? null;

	return next ? Number(next.slice(8, 10)) : null;
}

/** Validación del cuerpo de guardar / vista previa contra los contratos activos de la razón social. Devuelve los errores por campo. */
export function validateRuleInput(
	input: { contract_ids: string[]; main_contract_id: string },
	activeContractIds: Set<string>
): Array<{ field: string; message: string }> {
	const errors: Array<{ field: string; message: string }> = [];
	const unique = [...new Set(input.contract_ids)];

	if (unique.length < CONSOLIDATION_RULE_MIN_CONTRACTS) errors.push({ field: 'contract_ids', message: 'Elige al menos 2 contratos' });
	const foreign = unique.filter((id) => !activeContractIds.has(id));

	if (foreign.length) errors.push({ field: 'contract_ids', message: 'Hay contratos que no están activos o no facturan a esta razón social' });
	if (!unique.includes(input.main_contract_id))
		errors.push({ field: 'main_contract_id', message: 'El contrato principal tiene que estar entre los contratos elegidos' });

	return errors;
}
