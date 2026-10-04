import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DEFAULT_TIMEZONE, holdingTimezone } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { documentKindSql } from '@/modules/billing/billing-sql';
import { userAvatar, type UserAvatar } from '@/modules/me/user-avatar';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import {
	collectionChannelLabel,
	contractChangeTitle,
	contractEventTitle,
	describeContractChange,
	formatAmount,
	humanizeText,
	paymentMethodLabel,
} from './activity-labels';
import {
	MAX_NOTE_MENTIONS,
	MAX_NOTE_REFERENCES,
	NOTE_REFERENCE_TYPES,
	noteExcerpt,
	type NoteReference,
	type NoteReferenceType,
	parseNoteTokens,
	renderNoteText,
} from './client-note-tokens';

type Row = Record<string, unknown>;

/** Tipos de evento de la línea de tiempo del cliente (filtro de la pestaña Actividad). */
export const CLIENT_ACTIVITY_TYPES = ['note', 'contract', 'invoice', 'payment', 'collection', 'quote', 'document'] as const;
export type ClientActivityType = (typeof CLIENT_ACTIVITY_TYPES)[number];

/** `date` de Postgres → `YYYY-MM-DD` (el driver puede entregarlo como texto o como `Date` a medianoche local). */
const dayOf = (value: unknown): string => {
	if (value instanceof Date) {
		const pad = (n: number) => String(n).padStart(2, '0');

		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}

	return String(value ?? '').slice(0, 10);
};

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

/**
 * Primera rama de la unión (no aporta filas): fija nombres y tipos de las columnas. En un `UNION` los toma de la
 * primera rama, así que sin ella filtrar sin notas dejaba columnas sin nombre y la consulta fallaba.
 */
const FEED_COLUMNS = `SELECT NULL::text AS type, NULL::text AS id, NULL::timestamptz AS occurred_at, NULL::text AS title, NULL::text AS detail,
	NULL::text AS actor, NULL::text AS actor_id, NULL::text AS ref_kind, NULL::text AS ref_id, NULL::numeric AS amount, NULL::text AS currency,
	NULL::date AS occurred_day, NULL::text AS ref_parent_id, NULL::jsonb AS meta
	WHERE false`;

/**
 * Zona por defecto del negocio. Desde la ronda 4 de Configuración cada holding tiene la suya (`holding_settings.timezone`, leída con
 * `holdingTimezone`); va como parámetro `$3` de la consulta.
 */
export const ACTIVITY_TIME_ZONE = DEFAULT_TIMEZONE;

/**
 * Día del evento. Las fuentes con solo fecha (emisión de factura, fecha de pago, cotización sin `created_at`) lo traen en
 * `occurred_day`: castearlas a `timestamptz` las dejaba a medianoche UTC, que en Chile es el día anterior a las 21:00, y quedaban
 * mezcladas con los eventos con hora de otro día. Las fuentes con hora se llevan al día de la zona del holding.
 */
const OCCURRED_ON = `COALESCE(feed.occurred_day, (feed.occurred_at AT TIME ZONE $3::text)::date)`;

/**
 * Cada fuente aporta filas con la misma forma. `occurred_day` (fecha sin hora) va solo en las fuentes que no guardan hora;
 * `ref_parent_id` es el contrato de la factura (su vista rápida vive en el Contrato 360). `$1` = cliente, `$2` = holding. El orden y la paginación se aplican
 * sobre la unión. Contactos y acciones de agentes no entran: sus tablas no guardan fecha ni cliente.
 */
const SOURCES: Record<ClientActivityType, string[]> = {
	note: [
		`SELECT 'note' AS type, n.id::text AS id, n.created_at AS occurred_at, 'Nota' AS title, n.body AS detail,
			u.name AS actor, n.created_by::text AS actor_id, NULL::text AS ref_kind, NULL::text AS ref_id, NULL::numeric AS amount, NULL::text AS currency, NULL::date, NULL,
			jsonb_build_object('mentions', to_jsonb(n.mentioned_user_ids), 'references', n."references",
				'author_avatar_path', u.avatar_path, 'author_avatar_preset', u.avatar_preset)
		FROM client_activity_notes n LEFT JOIN users u ON u.id = n.created_by
		WHERE n.client_id = $1 AND n.holding_id = $2 AND n.deleted_at IS NULL`,
	],
	contract: [
		`SELECT 'contract', 'created-' || c.id::text, c.created_at::timestamptz, 'Contrato creado ' || COALESCE(c.contract_number, ''), c.status,
			NULL, NULL, 'contract', c.id::text, c.total_value, c.contract_currency, NULL, NULL, NULL
		FROM contracts c WHERE c.client_id = $1 AND c.holding_id = $2 AND c.created_at IS NOT NULL`,
		`SELECT 'contract', e.id::text, COALESCE(e.completed_at, e.created_at), NULLIF(e.title, ''),
			COALESCE(NULLIF(e.summary, ''), e.description), NULL, e.created_by::text, 'contract', c.id::text, e.amount_delta, c.contract_currency, NULL, NULL,
			jsonb_build_object('kind', 'event', 'event_type', e.event_type, 'number', c.contract_number)
		FROM contract_lifecycle_events e JOIN contracts c ON c.id = e.contract_id
		WHERE c.client_id = $1 AND c.holding_id = $2`,
		`SELECT 'contract', l.id::text, l.changed_at, NULL, NULLIF(l.reason, ''), l.changed_by_name, l.changed_by::text, 'contract', c.id::text, NULL, NULL, NULL, NULL,
			jsonb_build_object('kind', 'change', 'change_type', l.change_type, 'fields', to_jsonb(l.fields_changed), 'number', c.contract_number,
				'currency', c.contract_currency,
				'before', CASE WHEN upper(l.change_type) = 'UPDATE' THEN l.before_values END,
				'after', CASE WHEN upper(l.change_type) = 'UPDATE' THEN l.after_values END)
		FROM contract_change_log l JOIN contracts c ON c.id = l.contract_id
		WHERE c.client_id = $1 AND c.holding_id = $2`,
	],
	invoice: [
		`SELECT 'invoice', i.id::text, i.issue_date::timestamptz,
			(CASE ${documentKindSql('i')} WHEN 'credit_note' THEN 'Nota de crédito emitida ' WHEN 'debit_note' THEN 'Nota de débito emitida ' ELSE 'Factura emitida ' END)
				|| COALESCE(i.invoice_number, ''), i.status,
			NULL, NULL, 'invoice', i.id::text, i.total_invoice_currency, i.invoice_currency, i.issue_date, i.contract_id::text, NULL
		FROM invoices i WHERE i.client_id = $1 AND i.holding_id = $2 AND i.is_active AND i.issue_date IS NOT NULL
			AND i.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')`,
	],
	payment: [
		`SELECT 'payment', p.id::text, p.payment_date::timestamptz, 'Pago recibido · ' || COALESCE(i.invoice_number, ''), NULLIF(p.reference, ''),
			NULL, p.created_by::text, 'invoice', i.id::text, p.amount, p.currency, p.payment_date::date, i.contract_id::text,
			jsonb_build_object('method', p.method)
		FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
		WHERE i.client_id = $1 AND i.holding_id = $2 AND p.confirmed AND p.payment_date IS NOT NULL`,
	],
	collection: [
		`SELECT 'collection', g.id::text, g.sent_at, 'Gestión de cobranza · ' || COALESCE(i.invoice_number, ''), NULLIF(g.subject, ''),
			NULL, g.sent_by::text, 'invoice', i.id::text, NULL, NULL, NULL, i.contract_id::text,
			jsonb_build_object('channel', g.channel)
		FROM invoice_collection_logs g JOIN invoices i ON i.id = g.invoice_id
		WHERE i.client_id = $1 AND i.holding_id = $2 AND g.sent_at IS NOT NULL`,
	],
	quote: [
		`SELECT 'quote', q.id::text, COALESCE(q.created_at::timestamptz, q.quote_date::timestamptz), 'Cotización ' || COALESCE(q.quote_number, ''), qs.name,
			s.name, NULL, 'quote', q.id::text, q.total_amount, q.currency, CASE WHEN q.created_at IS NULL THEN q.quote_date::date END, NULL, NULL
		FROM quotes q LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id LEFT JOIN sellers s ON s.id = q.seller_id
		WHERE q.client_id = $1 AND q.holding_id = $2`,
	],
	document: [
		`SELECT 'document', d.id::text, d.uploaded_at::timestamptz, 'Documento subido', d.document_name,
			u.name, d.uploaded_by::text, 'document', d.id::text, NULL, NULL, NULL, NULL, NULL
		FROM client_documents d LEFT JOIN users u ON u.id = d.uploaded_by
		WHERE d.client_id = $1 AND d.holding_id = $2 AND d.deleted_at IS NULL AND d.uploaded_at IS NOT NULL`,
	],
};

/** Etiqueta de cada tipo referenciable (filtro `type` y textos). */
export const REFERENCE_TYPE_LABELS: Record<NoteReferenceType, string> = {
	contract: 'Contrato',
	invoice: 'Factura',
	credit_note: 'Nota de crédito',
	quote: 'Cotización',
	client_entity: 'Razón social',
	document: 'Documento',
};

export interface ResolvedReference {
	type: NoteReferenceType;
	id: string;
	label: string;
	sublabel: string | null;
	href: string;
}

/**
 * Elementos referenciables de un cliente (`#` en las notas, contrato §8.7): una consulta por tipo, siempre acotada a ese cliente y holding.
 * `$1` = cliente, `$2` = holding, `$3` = ids (o NULL = todos), `$4` = búsqueda ILIKE (o NULL). Devuelven `id`, `label`, `sublabel`, `sort`.
 */
const REFERENCE_SOURCES: Record<NoteReferenceType, string> = {
	contract: `SELECT c.id::text AS id, 'Contrato ' || COALESCE(c.contract_number, 'sin número') AS label, c.status AS sublabel,
			COALESCE(c.created_at::timestamptz, now()) AS sort
		FROM contracts c WHERE c.client_id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL
			AND ($3::uuid[] IS NULL OR c.id = ANY($3::uuid[])) AND ($4::text IS NULL OR c.contract_number ILIKE $4)`,
	invoice: `SELECT i.id::text AS id, 'Factura ' || COALESCE(i.invoice_number, 'sin número') AS label,
			concat_ws(' · ', upper(COALESCE(i.invoice_currency, '')) || ' ' || COALESCE(round(i.total_invoice_currency, 2)::text, ''), i.status) AS sublabel,
			COALESCE(i.issue_date, i.scheduled_at)::timestamptz AS sort, i.total_invoice_currency AS amount, upper(i.invoice_currency) AS currency, i.status
		FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id
		WHERE COALESCE(i.client_id, c.client_id) = $1 AND i.holding_id = $2 AND i.is_active AND ${documentKindSql('i')} = 'invoice'
			AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[])) AND ($4::text IS NULL OR i.invoice_number ILIKE $4)`,
	credit_note: `SELECT i.id::text AS id,
			(CASE ${documentKindSql('i')} WHEN 'debit_note' THEN 'Nota de débito ' ELSE 'Nota de crédito ' END) || COALESCE(i.invoice_number, 'sin número') AS label,
			NULL AS sublabel, COALESCE(i.issue_date, i.scheduled_at)::timestamptz AS sort, i.total_invoice_currency AS amount,
			upper(i.invoice_currency) AS currency, i.status
		FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id
		WHERE COALESCE(i.client_id, c.client_id) = $1 AND i.holding_id = $2 AND i.is_active AND ${documentKindSql('i')} IN ('credit_note', 'debit_note')
			AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[])) AND ($4::text IS NULL OR i.invoice_number ILIKE $4)`,
	quote: `SELECT q.id::text AS id, 'Cotización ' || COALESCE(q.quote_number, 'sin número') AS label, NULL AS sublabel,
			COALESCE(q.created_at::timestamptz, q.quote_date::timestamptz) AS sort, q.total_amount AS amount, upper(q.currency) AS currency
		FROM quotes q WHERE q.client_id = $1 AND q.holding_id = $2 AND q.deleted_at IS NULL
			AND ($3::uuid[] IS NULL OR q.id = ANY($3::uuid[])) AND ($4::text IS NULL OR q.quote_number ILIKE $4)`,
	client_entity: `SELECT ce.id::text AS id, 'Razón social ' || COALESCE(ce.legal_name, 'sin nombre') AS label, ce.tax_id AS sublabel, NULL::timestamptz AS sort
		FROM client_entities ce WHERE ce.holding_id = $2
			AND (ce.client_id = $1 OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1))
			AND ($3::uuid[] IS NULL OR ce.id = ANY($3::uuid[])) AND ($4::text IS NULL OR ce.legal_name ILIKE $4 OR ce.tax_id ILIKE $4)`,
	document: `SELECT d.id::text AS id, 'Documento ' || COALESCE(d.document_name, 'sin nombre') AS label, NULL AS sublabel, d.uploaded_at::timestamptz AS sort
		FROM client_documents d WHERE d.client_id = $1 AND d.holding_id = $2 AND d.deleted_at IS NULL
			AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[])) AND ($4::text IS NULL OR d.document_name ILIKE $4)`,
};

/** Enlace al front nuevo de cada elemento referenciado. */
export function referenceHref(type: NoteReferenceType, id: string, clientId: string): string {
	switch (type) {
		case 'contract':
			return `/contratos/${id}`;
		case 'invoice':
		case 'credit_note':
			return `/facturacion?invoice=${id}`;
		case 'quote':
			return `/cotizaciones/${id}`;
		case 'client_entity':
			return `/clientes/razones-sociales/${id}`;
		default:
			return `/clientes/${clientId}?tab=documentos`;
	}
}

/** Bajada legible de facturas y NC: "USD 1.200 · Pagada". */
const amountSublabel = (row: Row) =>
	[row.amount !== null && row.amount !== undefined ? formatAmount(row.amount, text(row.currency)) : null, text(row.status)]
		.filter(Boolean)
		.join(' · ') || null;

/**
 * Línea de tiempo del cliente comercial (pestaña Actividad del Cliente 360): eventos de contratos, facturas, pagos,
 * cobranza, cotizaciones y documentos, más las notas que escriben los usuarios (`client_activity_notes`). Todo texto sale en español de
 * negocio (`activity-labels.ts`). Las notas aceptan menciones `@[user:<id>]` y referencias `#[<tipo>:<id>]` a elementos del mismo cliente
 * (Notificaciones v2 fase 2, contrato §8.7): se validan al guardar, se devuelven resueltas al leer y la mención crea la alerta `user_mention`.
 */
@Injectable()
export class ClientActivityService {
	private readonly logger = new Logger(ClientActivityService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly notifications: NotificationsService
	) {}

	private async assertClientInHolding(clientId: string, holdingId: string): Promise<Row> {
		const rows = await this.dataSource.query<Row[]>(`SELECT id, name_commercial FROM clients WHERE id = $1 AND holding_id = $2`, [
			clientId,
			holdingId,
		]);

		if (rows.length === 0) throw new NotFoundException('Cliente no encontrado');

		return rows[0];
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

		const timezone = await holdingTimezone(this.dataSource, holdingId);
		const [rows, [countRow], currentUserId] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT feed.*, ${OCCURRED_ON} AS occurred_on, (feed.occurred_day IS NOT NULL) AS all_day
				FROM (${union}) feed WHERE occurred_at IS NOT NULL
				ORDER BY ${OCCURRED_ON} DESC, (feed.occurred_day IS NOT NULL), occurred_at DESC, type, id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				[clientId, holdingId, timezone]
			),
			this.dataSource.query<Row[]>(`SELECT COUNT(*) AS total FROM (${union}) feed WHERE occurred_at IS NOT NULL`, [clientId, holdingId]),
			this.userId(authId),
		]);
		const total = Number(countRow?.total ?? 0);
		const notes = await this.resolveNotes(
			clientId,
			holdingId,
			rows.filter((row) => row.type === 'note')
		);

		return {
			data: rows.map((row) => {
				const presented = present(row);
				const note = row.type === 'note' ? notes.get(String(row.id)) : undefined;

				return {
					id: String(row.id),
					type: row.type as ClientActivityType,
					occurred_at: new Date(String(row.occurred_at)).toISOString(),
					/** Día del evento en la zona del negocio (`YYYY-MM-DD`): agrupa la línea de tiempo. */
					occurred_on: dayOf(row.occurred_on),
					/** Solo fecha, sin hora (no se muestra hora). */
					all_day: row.all_day === true || row.all_day === 't',
					title: presented.title,
					detail: note ? note.text : presented.detail,
					actor: text(row.actor),
					ref: row.ref_kind ? { kind: String(row.ref_kind), id: String(row.ref_id), contract_id: text(row.ref_parent_id) } : null,
					amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
					currency: text(row.currency),
					/** Solo el autor puede borrar su nota. */
					can_delete: row.type === 'note' && Boolean(currentUserId) && row.actor_id === currentUserId,
					...(note ? { body: note.body, author_avatar: note.author_avatar, mentions: note.mentions, references: note.references } : {}),
				};
			}),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
		};
	}

	/**
	 * Agrega una nota. Deriva menciones y referencias de los tokens del texto y valida: cada mención es miembro activo del holding y cada
	 * referencia es de ESE cliente y holding (si no, 400). Luego crea la alerta `user_mention` a los mencionados (no al autor); un fallo de la
	 * alerta no deshace la nota.
	 */
	async addNote(clientId: string, holdingId: string, authId: string, body: string) {
		const client = await this.assertClientInHolding(clientId, holdingId);
		const trimmed = body.trim();
		const { mentioned_user_ids: mentions, references } = parseNoteTokens(trimmed);

		if (mentions.length > MAX_NOTE_MENTIONS)
			throw validationException([{ field: 'body', message: `Puedes mencionar hasta ${MAX_NOTE_MENTIONS} personas por nota` }]);
		if (references.length > MAX_NOTE_REFERENCES)
			throw validationException([{ field: 'body', message: `Puedes referenciar hasta ${MAX_NOTE_REFERENCES} elementos por nota` }]);
		const [members, resolved, authorId] = await Promise.all([
			this.activeMembers(holdingId, mentions),
			this.resolveReferences(clientId, holdingId, references),
			this.userId(authId),
		]);

		if (members.size !== mentions.length)
			throw validationException([{ field: 'body', message: 'La persona mencionada no es parte de este holding' }]);
		const missing = references.filter((reference) => !resolved.has(`${reference.type}:${reference.id}`));

		if (missing.length) {
			throw validationException([
				{
					field: 'body',
					message: `La referencia no pertenece a este cliente: ${[...new Set(missing.map((item) => REFERENCE_TYPE_LABELS[item.type].toLowerCase()))].join(', ')}`,
				},
			]);
		}
		const [row] = await this.dataSource.query<Row[]>(
			`INSERT INTO client_activity_notes (holding_id, client_id, body, created_by, mentioned_user_ids, "references")
			VALUES ($1, $2, $3, $4, $5::uuid[], $6::jsonb) RETURNING id, created_at`,
			[holdingId, clientId, trimmed, authorId, mentions, JSON.stringify(references)]
		);
		const noteId = String(row.id);

		await this.notifyMentions({
			holdingId,
			clientId,
			clientName: text(client.name_commercial) ?? 'un cliente',
			noteId,
			authorId,
			mentions: [...members.keys()].filter((id) => id !== authorId),
			text: renderNoteText(trimmed, members, new Map([...resolved].map(([key, value]) => [key, value.label]))),
		});

		return { id: noteId, created_at: new Date(String(row.created_at)).toISOString(), mentioned_user_ids: mentions, references };
	}

	/** Elementos referenciables del cliente (`GET /clients/:id/references`): por tipo o todos, con búsqueda; más recientes primero. */
	async references(clientId: string, holdingId: string, query: { search?: string; type?: NoteReferenceType; limit?: number }) {
		await this.assertClientInHolding(clientId, holdingId);
		const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);
		const like = query.search?.trim() ? `%${query.search.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
		const types = query.type ? [query.type] : [...NOTE_REFERENCE_TYPES];
		const groups = await Promise.all(
			types.map(async (type) => {
				const rows = await this.dataSource.query<Row[]>(
					`SELECT * FROM (${REFERENCE_SOURCES[type]}) r ORDER BY r.sort DESC NULLS LAST, r.label LIMIT ${limit}`,
					[clientId, holdingId, null, like]
				);

				return rows.map((row) => this.toReference(type, row, clientId));
			})
		);

		return { data: groups.flat().slice(0, query.type ? limit : limit * types.length) };
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

	// ---------------------------------------------------------------- internos

	private toReference(type: NoteReferenceType, row: Row, clientId: string): ResolvedReference {
		const id = String(row.id);

		return {
			type,
			id,
			label: humanizeText(String(row.label ?? REFERENCE_TYPE_LABELS[type])),
			sublabel: type === 'invoice' || type === 'credit_note' ? amountSublabel(row) : text(row.sublabel),
			href: referenceHref(type, id, clientId),
		};
	}

	/** Referencias que siguen existiendo y son del cliente: `tipo:id` → referencia resuelta (etiqueta actual). */
	private async resolveReferences(clientId: string, holdingId: string, references: NoteReference[]): Promise<Map<string, ResolvedReference>> {
		const resolved = new Map<string, ResolvedReference>();
		const byType = new Map<NoteReferenceType, string[]>();

		for (const reference of references) byType.set(reference.type, [...(byType.get(reference.type) ?? []), reference.id]);
		await Promise.all(
			[...byType].map(async ([type, ids]) => {
				const rows = await this.dataSource.query<Row[]>(`SELECT * FROM (${REFERENCE_SOURCES[type]}) r`, [clientId, holdingId, ids, null]);

				for (const row of rows) resolved.set(`${type}:${String(row.id).toLowerCase()}`, this.toReference(type, row, clientId));
			})
		);

		return resolved;
	}

	/** Miembros activos del holding entre los ids: id → nombre. */
	private async activeMembers(holdingId: string, userIds: string[]): Promise<Map<string, string>> {
		if (!userIds.length) return new Map();
		const rows = await this.dataSource.query<Row[]>(
			`SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name FROM users u JOIN user_holdings uh ON uh.user_id = u.id
			WHERE uh.holding_id = $1 AND uh.is_active = true AND u.status = 'Activo' AND u.id = ANY($2::uuid[])`,
			[holdingId, userIds]
		);

		return new Map(rows.map((row) => [String(row.id).toLowerCase(), String(row.name ?? 'usuario')]));
	}

	/** Notas de la página: texto legible, menciones (con nombre y si sigue siendo miembro) y referencias resueltas. */
	private async resolveNotes(clientId: string, holdingId: string, rows: Row[]) {
		const result = new Map<
			string,
			{
				body: string;
				text: string;
				/** Avatar del autor (viene en `meta` de la misma consulta del feed). */
				author_avatar: UserAvatar;
				mentions: Array<{ id: string; name: string; avatar: UserAvatar; exists: boolean }>;
				references: Array<ResolvedReference & { exists: boolean }>;
			}
		>();

		if (!rows.length) return result;
		const parsed = rows.map((row) => {
			const meta = (row.meta ?? {}) as { mentions?: unknown; references?: unknown };
			const tokens = parseNoteTokens(String(row.detail ?? ''));
			const mentions =
				Array.isArray(meta.mentions) && meta.mentions.length
					? meta.mentions.map((id) => String(id).toLowerCase())
					: tokens.mentioned_user_ids;
			const references = Array.isArray(meta.references) && meta.references.length ? (meta.references as NoteReference[]) : tokens.references;

			return { row, mentions, references };
		});
		const allMentions = [...new Set(parsed.flatMap((item) => item.mentions))];
		const [names, members, resolved] = await Promise.all([
			allMentions.length
				? this.dataSource.query<Row[]>(
						`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, avatar_path, avatar_preset FROM users WHERE id = ANY($1::uuid[])`,
						[allMentions]
					)
				: Promise.resolve([] as Row[]),
			this.activeMembers(holdingId, allMentions),
			this.resolveReferences(
				clientId,
				holdingId,
				parsed.flatMap((item) => item.references)
			),
		]);
		const nameById = new Map(names.map((row) => [String(row.id).toLowerCase(), String(row.name ?? 'usuario')]));
		const avatarById = new Map(names.map((row) => [String(row.id).toLowerCase(), userAvatar(row)]));
		const labels = new Map([...resolved].map(([key, value]) => [key, value.label]));

		for (const { row, mentions, references } of parsed) {
			const body = String(row.detail ?? '');
			const meta = (row.meta ?? {}) as Row;

			result.set(String(row.id), {
				body,
				text: renderNoteText(body, nameById, labels),
				author_avatar: userAvatar({ avatar_path: meta.author_avatar_path, avatar_preset: meta.author_avatar_preset }),
				mentions: mentions.map((id) => ({
					id,
					name: nameById.get(id) ?? 'usuario',
					avatar: avatarById.get(id) ?? { kind: 'initials' },
					exists: members.has(id),
				})),
				references: references.map((reference) => {
					const key = `${reference.type}:${String(reference.id).toLowerCase()}`;
					const found = resolved.get(key);

					return found
						? { ...found, exists: true }
						: {
								type: reference.type,
								id: reference.id,
								label: `${REFERENCE_TYPE_LABELS[reference.type] ?? 'Elemento'} ya no disponible`,
								sublabel: null,
								href: referenceHref(reference.type, reference.id, clientId),
								exists: false,
							};
				}),
			});
		}

		return result;
	}

	private async notifyMentions(input: {
		holdingId: string;
		clientId: string;
		clientName: string;
		noteId: string;
		authorId: string | null;
		mentions: string[];
		text: string;
	}) {
		if (!input.mentions.length) return;
		try {
			const [author] = input.authorId
				? await this.dataSource.query<Row[]>(`SELECT COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = $1`, [input.authorId])
				: [];
			const authorName = text(author?.name) ?? 'Alguien';

			await this.notifications.createOrUpdate(input.holdingId, {
				source: 'clients',
				type: 'user_mention',
				severity: 'info',
				title: `${authorName} te mencionó en ${input.clientName}`,
				message: noteExcerpt(input.text),
				recommendation: 'Abre el comentario en la Actividad del cliente para responder.',
				action_type: 'open_client_activity',
				action_payload: { client_id: input.clientId, note_id: input.noteId },
				resource_type: 'client',
				resource_id: input.clientId,
				// `actor_user_id`: quien mencionó (la alerta lo devuelve como `actor` con nombre y avatar). `author_id` queda por compatibilidad.
				metadata: { client_id: input.clientId, note_id: input.noteId, author_id: input.authorId, actor_user_id: input.authorId },
				deduplication_key: `client-note-mention:${input.noteId}`,
				recipients: { user_ids: input.mentions },
			});
		} catch (error) {
			this.logger.warn(`No se pudo avisar la mención de la nota ${input.noteId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** Título y detalle legibles de una fila de la línea de tiempo (sin códigos ni nombres de campo). */
export function present(row: Row): { title: string; detail: string | null } {
	const meta = (row.meta ?? {}) as Record<string, unknown>;
	const clean = (value: unknown) => (text(value) ? humanizeText(String(value).trim()) : null);
	const number = text(meta.number);

	switch (row.type) {
		case 'contract':
			if (meta.kind === 'change') {
				return {
					title: contractChangeTitle(text(meta.change_type), number),
					detail: describeContractChange({
						change_type: text(meta.change_type),
						fields: meta.fields,
						before: (meta.before ?? null) as Record<string, unknown> | null,
						after: (meta.after ?? null) as Record<string, unknown> | null,
						currency: text(meta.currency),
						reason: text(row.detail),
					}),
				};
			}
			if (meta.kind === 'event') {
				return {
					title: `${contractEventTitle(text(row.title), text(meta.event_type))}${number ? ` · ${number}` : ''}`,
					detail: clean(row.detail),
				};
			}
			return { title: clean(row.title) ?? 'Contrato', detail: clean(row.detail) };
		case 'payment':
			return {
				title: String(row.title ?? '').trim(),
				detail: [paymentMethodLabel(text(meta.method)), text(row.detail)].filter(Boolean).join(' · ') || null,
			};
		case 'collection':
			return {
				title: String(row.title ?? '').trim(),
				detail: [collectionChannelLabel(text(meta.channel)), text(row.detail)].filter(Boolean).join(' · ') || null,
			};
		case 'note':
			return { title: 'Nota', detail: text(row.detail) };
		case 'document':
			// Nombre de archivo tal cual (no se "limpia").
			return { title: String(row.title ?? '').trim(), detail: text(row.detail) };
		default:
			return { title: clean(row.title) ?? '', detail: clean(row.detail) };
	}
}
