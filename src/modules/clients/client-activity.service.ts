import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

type Row = Record<string, unknown>;

/** Tipos de evento de la línea de tiempo del cliente (filtro de la pestaña Actividad). */
export const CLIENT_ACTIVITY_TYPES = ['note', 'contract', 'invoice', 'payment', 'collection', 'quote', 'document'] as const;
export type ClientActivityType = (typeof CLIENT_ACTIVITY_TYPES)[number];

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

/**
 * Primera rama de la unión (no aporta filas): fija nombres y tipos de las columnas. En un `UNION` los toma de la
 * primera rama, así que sin ella filtrar sin notas dejaba columnas sin nombre y la consulta fallaba.
 */
const FEED_COLUMNS = `SELECT NULL::text AS type, NULL::text AS id, NULL::timestamptz AS occurred_at, NULL::text AS title, NULL::text AS detail,
	NULL::text AS actor, NULL::text AS actor_id, NULL::text AS ref_kind, NULL::text AS ref_id, NULL::numeric AS amount, NULL::text AS currency
	WHERE false`;

/**
 * Cada fuente aporta filas con la misma forma. `$1` = cliente, `$2` = holding. El orden y la paginación se aplican
 * sobre la unión. Contactos y acciones de agentes no entran: sus tablas no guardan fecha ni cliente.
 */
const SOURCES: Record<ClientActivityType, string[]> = {
	note: [
		`SELECT 'note' AS type, n.id::text AS id, n.created_at AS occurred_at, 'Nota' AS title, n.body AS detail,
			u.name AS actor, n.created_by::text AS actor_id, NULL::text AS ref_kind, NULL::text AS ref_id, NULL::numeric AS amount, NULL::text AS currency
		FROM client_activity_notes n LEFT JOIN users u ON u.id = n.created_by
		WHERE n.client_id = $1 AND n.holding_id = $2 AND n.deleted_at IS NULL`,
	],
	contract: [
		`SELECT 'contract', 'created-' || c.id::text, c.created_at::timestamptz, 'Contrato creado ' || COALESCE(c.contract_number, ''), c.status,
			NULL, NULL, 'contract', c.id::text, c.total_value, c.contract_currency
		FROM contracts c WHERE c.client_id = $1 AND c.holding_id = $2 AND c.created_at IS NOT NULL`,
		`SELECT 'contract', e.id::text, COALESCE(e.completed_at, e.created_at),
			COALESCE(NULLIF(e.title, ''), initcap(replace(e.event_type, '_', ' '))) || ' · ' || COALESCE(c.contract_number, ''),
			COALESCE(NULLIF(e.summary, ''), e.description), NULL, e.created_by::text, 'contract', c.id::text, e.amount_delta, c.contract_currency
		FROM contract_lifecycle_events e JOIN contracts c ON c.id = e.contract_id
		WHERE c.client_id = $1 AND c.holding_id = $2`,
		`SELECT 'contract', l.id::text, l.changed_at, 'Contrato modificado · ' || COALESCE(c.contract_number, ''),
			COALESCE(NULLIF(l.reason, ''), array_to_string(l.fields_changed, ', ')), l.changed_by_name, l.changed_by::text, 'contract', c.id::text, NULL, NULL
		FROM contract_change_log l JOIN contracts c ON c.id = l.contract_id
		WHERE c.client_id = $1 AND c.holding_id = $2`,
	],
	invoice: [
		`SELECT 'invoice', i.id::text, i.issue_date::timestamptz, 'Factura emitida ' || COALESCE(i.invoice_number, ''), i.status,
			NULL, NULL, 'invoice', i.id::text, i.total_invoice_currency, i.invoice_currency
		FROM invoices i WHERE i.client_id = $1 AND i.holding_id = $2 AND i.is_active AND i.issue_date IS NOT NULL
			AND i.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')`,
	],
	payment: [
		`SELECT 'payment', p.id::text, p.payment_date::timestamptz, 'Pago recibido · ' || COALESCE(i.invoice_number, ''), NULLIF(concat_ws(' · ', p.method, p.reference), ''),
			NULL, p.created_by::text, 'invoice', i.id::text, p.amount, p.currency
		FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
		WHERE i.client_id = $1 AND i.holding_id = $2 AND p.confirmed AND p.payment_date IS NOT NULL`,
	],
	collection: [
		`SELECT 'collection', g.id::text, g.sent_at, 'Gestión de cobranza · ' || COALESCE(i.invoice_number, ''), NULLIF(concat_ws(' · ', g.channel, g.subject), ''),
			NULL, g.sent_by::text, 'invoice', i.id::text, NULL, NULL
		FROM invoice_collection_logs g JOIN invoices i ON i.id = g.invoice_id
		WHERE i.client_id = $1 AND i.holding_id = $2 AND g.sent_at IS NOT NULL`,
	],
	quote: [
		`SELECT 'quote', q.id::text, COALESCE(q.created_at::timestamptz, q.quote_date::timestamptz), 'Cotización ' || COALESCE(q.quote_number, ''), qs.name,
			s.name, NULL, 'quote', q.id::text, q.total_amount, q.currency
		FROM quotes q LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id LEFT JOIN sellers s ON s.id = q.seller_id
		WHERE q.client_id = $1 AND q.holding_id = $2`,
	],
	document: [
		`SELECT 'document', d.id::text, d.uploaded_at::timestamptz, 'Documento subido', d.document_name,
			u.name, d.uploaded_by::text, 'document', d.id::text, NULL, NULL
		FROM client_documents d LEFT JOIN users u ON u.id = d.uploaded_by
		WHERE d.client_id = $1 AND d.holding_id = $2 AND d.deleted_at IS NULL AND d.uploaded_at IS NOT NULL`,
	],
};

/**
 * Línea de tiempo del cliente comercial (pestaña Actividad del Cliente 360): eventos de contratos, facturas, pagos,
 * cobranza, cotizaciones y documentos, más las notas que escriben los usuarios (`client_activity_notes`).
 */
@Injectable()
export class ClientActivityService {
	constructor(private readonly dataSource: DataSource) {}

	private async assertClientInHolding(clientId: string, holdingId: string) {
		const rows = await this.dataSource.query<Row[]>(`SELECT 1 FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId]);

		if (rows.length === 0) throw new NotFoundException('Cliente no encontrado');
	}

	private async userId(authId: string): Promise<string | null> {
		const [row] = await this.dataSource.query<Row[]>(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [authId]);

		return row ? String(row.id) : null;
	}

	async list(
		clientId: string,
		holdingId: string,
		authId: string,
		{ types, page = 1, limit = 30 }: { types?: ClientActivityType[]; page?: number; limit?: number }
	) {
		await this.assertClientInHolding(clientId, holdingId);
		const selected = types?.length ? types : [...CLIENT_ACTIVITY_TYPES];
		const union = [FEED_COLUMNS, ...selected.flatMap((type) => SOURCES[type])].join('\nUNION ALL\n');
		const offset = (page - 1) * limit;

		const [rows, [countRow], currentUserId] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT * FROM (${union}) feed WHERE occurred_at IS NOT NULL
				ORDER BY occurred_at DESC, id LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				[clientId, holdingId]
			),
			this.dataSource.query<Row[]>(`SELECT COUNT(*) AS total FROM (${union}) feed WHERE occurred_at IS NOT NULL`, [clientId, holdingId]),
			this.userId(authId),
		]);
		const total = Number(countRow?.total ?? 0);

		return {
			data: rows.map((row) => ({
				id: String(row.id),
				type: row.type as ClientActivityType,
				occurred_at: new Date(String(row.occurred_at)).toISOString(),
				title: String(row.title ?? '').trim(),
				detail: text(row.detail),
				actor: text(row.actor),
				ref: row.ref_kind ? { kind: String(row.ref_kind), id: String(row.ref_id) } : null,
				amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
				currency: text(row.currency),
				/** Solo el autor puede borrar su nota. */
				can_delete: row.type === 'note' && Boolean(currentUserId) && row.actor_id === currentUserId,
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
		};
	}

	async addNote(clientId: string, holdingId: string, authId: string, body: string) {
		await this.assertClientInHolding(clientId, holdingId);
		const [row] = await this.dataSource.query<Row[]>(
			`INSERT INTO client_activity_notes (holding_id, client_id, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
			[holdingId, clientId, body.trim(), await this.userId(authId)]
		);

		return { id: String(row.id), created_at: new Date(String(row.created_at)).toISOString() };
	}

	/** Borra (lógicamente) una nota. Solo su autor. */
	async deleteNote(clientId: string, noteId: string, holdingId: string, authId: string) {
		const [note] = await this.dataSource.query<Row[]>(
			`SELECT created_by FROM client_activity_notes WHERE id = $1 AND client_id = $2 AND holding_id = $3 AND deleted_at IS NULL`,
			[noteId, clientId, holdingId]
		);

		if (!note) throw new NotFoundException('Nota no encontrada');
		if (!note.created_by || String(note.created_by) !== (await this.userId(authId)))
			throw new ForbiddenException('Solo quien escribió la nota puede borrarla');
		await this.dataSource.query(`UPDATE client_activity_notes SET deleted_at = now() WHERE id = $1`, [noteId]);

		return { id: noteId };
	}
}
