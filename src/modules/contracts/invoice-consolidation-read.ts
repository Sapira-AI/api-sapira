import { round2 } from './billing-engine';
import { upperCode } from './multicurrency';

/**
 * Lectura de documentos unificados en el 360 (`docs/v2-rediseno/spec-multimoneda-contrato.md` §9): marca `legacy_unified` y aporte por
 * contrato. Archivo aparte, sin dependencias de servicios, para que `contracts.service.ts` lo importe sin ciclos (la consolidación importa
 * `contract-invoices.ts`, que a su vez llega a `contracts.service.ts`).
 */

export const UNIFIED_INVOICE_TYPES = ['Unificada', 'Consolidada'] as const;
export const CONSOLIDATION_EVENT_TYPES = { consolidated: 'INVOICE_CONSOLIDATED', undone: 'INVOICE_CONSOLIDATION_UNDONE' } as const;

export const isUnifiedType = (invoiceType: string | null | undefined) => (UNIFIED_INVOICE_TYPES as readonly string[]).includes(invoiceType ?? '');

/** Fila agregada por factura y contrato (`contributionsSql`). */
export interface ContributionRow {
	invoice_id: string;
	contract_id: string | null;
	contract_number: string | null;
	currency: string | null;
	lines_count: number;
	subtotal: number;
	subtotal_invoice_currency: number | null;
}

export interface InvoiceContribution {
	contract_id: string | null;
	contract_number: string | null;
	lines_count: number;
	subtotal_invoice_currency: number | null;
	subtotal_by_currency: Array<{ currency: string; subtotal: number }>;
}

/** Aporte por contrato de cada documento unificado (de las filas por factura, contrato y moneda), ordenado por aporte. */
export function contributionsByInvoice(rows: ContributionRow[]): Map<string, InvoiceContribution[]> {
	const result = new Map<string, Map<string, InvoiceContribution>>();

	for (const row of rows) {
		const byContract = result.get(row.invoice_id) ?? new Map<string, InvoiceContribution>();
		const key = row.contract_id ?? '';
		const current = byContract.get(key) ?? {
			contract_id: row.contract_id,
			contract_number: row.contract_number,
			lines_count: 0,
			subtotal_invoice_currency: 0,
			subtotal_by_currency: [],
		};

		current.lines_count += row.lines_count;
		current.subtotal_invoice_currency =
			current.subtotal_invoice_currency === null || row.subtotal_invoice_currency === null
				? null
				: round2(current.subtotal_invoice_currency + row.subtotal_invoice_currency);
		if (row.currency) current.subtotal_by_currency.push({ currency: upperCode(row.currency), subtotal: round2(row.subtotal) });
		byContract.set(key, current);
		result.set(row.invoice_id, byContract);
	}

	return new Map(
		[...result.entries()].map(([invoiceId, byContract]) => [
			invoiceId,
			[...byContract.values()].sort(
				(a, b) =>
					(b.subtotal_invoice_currency ?? 0) - (a.subtotal_invoice_currency ?? 0) ||
					(a.contract_number ?? '').localeCompare(b.contract_number ?? '')
			),
		])
	);
}

/**
 * Consulta de lectura (un solo viaje para la página): por documento unificado, si tiene evento `INVOICE_CONSOLIDATED` (v2) y su aporte por
 * contrato y moneda de línea (contrato de la línea; si falta, el del ítem; si falta, el del encabezado). `$1` = ids, `$2` = holding.
 */
export const UNIFIED_READ_SQL = `SELECT i.id AS invoice_id,
		EXISTS (SELECT 1 FROM contract_lifecycle_events e WHERE e.holding_id = i.holding_id AND e.event_type = '${CONSOLIDATION_EVENT_TYPES.consolidated}'
			AND e.metadata->>'consolidated_invoice_id' = i.id::text) AS consolidated_v2,
		s.contract_id, c.contract_number, s.currency, COALESCE(s.lines_count, 0) AS lines_count, COALESCE(s.subtotal, 0) AS subtotal, s.subtotal_invoice_currency
	FROM invoices i
	LEFT JOIN LATERAL (
		SELECT COALESCE(ii.contract_id, ci.contract_id, i.contract_id) AS contract_id, COALESCE(ii.contract_currency, i.contract_currency) AS currency,
			COUNT(*) AS lines_count, SUM(ii.subtotal_contract_currency) AS subtotal,
			CASE WHEN bool_or(ii.subtotal_invoice_currency IS NULL) THEN NULL ELSE SUM(ii.subtotal_invoice_currency) END AS subtotal_invoice_currency
		FROM invoice_items ii LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
		WHERE ii.invoice_id = i.id
		GROUP BY 1, 2
	) s ON true
	LEFT JOIN contracts c ON c.id = s.contract_id AND c.holding_id = i.holding_id
	WHERE i.id = ANY($1::uuid[]) AND i.holding_id = $2`;

/** Campos de lectura de un documento unificado: `legacy_unified` (sin evento v2) y el aporte por contrato. */
export interface UnifiedReadFields {
	legacy_unified: boolean;
	contributions: InvoiceContribution[];
}

export function unifiedReadFields(rows: Array<Record<string, unknown>>): Map<string, UnifiedReadFields> {
	const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
	const num = (value: unknown) => Number(value ?? 0) || 0;
	const v2 = new Map<string, boolean>();
	const contributionRows: ContributionRow[] = [];

	for (const row of rows) {
		const invoiceId = String(row.invoice_id);

		v2.set(invoiceId, row.consolidated_v2 === true || v2.get(invoiceId) === true);
		if (num(row.lines_count) === 0) continue;
		contributionRows.push({
			invoice_id: invoiceId,
			contract_id: text(row.contract_id),
			contract_number: text(row.contract_number),
			currency: text(row.currency),
			lines_count: num(row.lines_count),
			subtotal: num(row.subtotal),
			subtotal_invoice_currency:
				row.subtotal_invoice_currency === null || row.subtotal_invoice_currency === undefined ? null : num(row.subtotal_invoice_currency),
		});
	}
	const contributions = contributionsByInvoice(contributionRows);

	return new Map(
		[...v2.entries()].map(([invoiceId, isV2]) => [invoiceId, { legacy_unified: !isV2, contributions: contributions.get(invoiceId) ?? [] }])
	);
}
