import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { OPEN_INVOICE_STATUSES } from './client-metrics.service';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** Columnas ordenables (lista blanca → expresión SQL; nunca se interpola el input). */
export const ENTITY_SORT_FIELDS = {
	legal_name: 'ce.legal_name',
	tax_id: 'ce.tax_id',
	country: 'ce.country',
	clients_count: 'clients_count',
	receivable: 'receivable',
	overdue: 'overdue',
} as const;

export const CONTACT_SORT_FIELDS = {
	name: 'cc.name',
	email: 'cc.email',
	contact_type: 'cc.contact_type',
	position: 'cc.position',
	client_name: 'c.name_commercial',
} as const;

export interface ListEntitiesParams {
	page?: number;
	limit?: number;
	search?: string;
	country?: string;
	unassigned?: boolean;
	sortBy?: keyof typeof ENTITY_SORT_FIELDS;
	sortOrder?: 'asc' | 'desc';
}

export interface ListContactsParams {
	page?: number;
	limit?: number;
	search?: string;
	clientId?: string;
	contactType?: string;
	sortBy?: keyof typeof CONTACT_SORT_FIELDS;
	sortOrder?: 'asc' | 'desc';
}

const paginated = <T>(data: T[], total: number, page: number, limit: number) => ({
	data,
	items: total,
	pages: Math.max(1, Math.ceil(total / limit)),
	currentPage: page,
	limit,
});

/**
 * Directorio de clientes para el rediseño: razones sociales (con los clientes comerciales a los que
 * facturan) y contactos. Todo acotado al holding recibido.
 */
@Injectable()
export class ClientDirectoryService {
	constructor(private readonly dataSource: DataSource) {}

	async listEntities(
		holdingId: string,
		{ page = 1, limit = 25, search, country, unassigned, sortBy = 'legal_name', sortOrder = 'asc' }: ListEntitiesParams,
		asOfDate = new Date()
	) {
		const params: unknown[] = [holdingId, OPEN_INVOICE_STATUSES, isoDate(asOfDate)];
		const filters: string[] = ['ce.holding_id = $1'];

		if (search) filters.push(`(ce.legal_name ILIKE $${params.push(`%${search}%`)} OR ce.tax_id ILIKE $${params.length})`);
		if (country) filters.push(`ce.country = $${params.push(country)}`);
		if (unassigned) filters.push('NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id)');
		const where = `WHERE ${filters.join(' AND ')}`;
		const order = `${ENTITY_SORT_FIELDS[sortBy] ?? 'ce.legal_name'} ${sortOrder === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ce.id`;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT ce.id, ce.legal_name, ce.tax_id, ce.country, ce.email, ce.odoo_partner_id,
					COALESCE(cl.clients, '[]'::json) AS clients, COALESCE(cl.clients_count, 0) AS clients_count,
					COALESCE(ar.receivable, 0) AS receivable, COALESCE(ar.overdue, 0) AS overdue
				FROM client_entities ce
				LEFT JOIN LATERAL (
					SELECT json_agg(json_build_object('id', c.id, 'name', c.name_commercial, 'is_primary', x.is_primary) ORDER BY x.is_primary DESC, c.name_commercial) AS clients,
						COUNT(*) AS clients_count
					FROM client_entity_clients x JOIN clients c ON c.id = x.client_id
					WHERE x.client_entity_id = ce.id
				) cl ON true
				LEFT JOIN LATERAL (
					SELECT SUM(i.total_system_currency) FILTER (WHERE i.status = ANY($2)) AS receivable,
						SUM(i.total_system_currency) FILTER (WHERE i.status = ANY($2) AND i.due_date < $3::date) AS overdue
					FROM invoices i WHERE i.client_entity_id = ce.id AND i.is_active = true
				) ar ON true
				${where}
				ORDER BY ${order}
				LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`,
				params
			),
			// Comparte `params` con la consulta principal: $2 y $3 se tipan aquí para que Postgres no rechace parámetros sin usar.
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS total FROM client_entities ce ${where} AND $2::text[] IS NOT NULL AND $3::date IS NOT NULL`,
				params
			),
		]);

		return paginated(
			rows.map((row) => ({
				id: row.id as string,
				legal_name: (row.legal_name as string) ?? null,
				tax_id: (row.tax_id as string) ?? null,
				country: (row.country as string) ?? null,
				email: (row.email as string) ?? null,
				odoo_partner_id: row.odoo_partner_id === null || row.odoo_partner_id === undefined ? null : Number(row.odoo_partner_id),
				clients: (row.clients as Array<{ id: string; name: string | null; is_primary: boolean }>) ?? [],
				clients_count: toNumber(row.clients_count),
				receivable: toNumber(row.receivable),
				overdue: toNumber(row.overdue),
			})),
			toNumber(countRow?.total),
			page,
			limit
		);
	}

	async entityStats(holdingId: string) {
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT COUNT(*) AS total,
				COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id)) AS unassigned,
				array_agg(DISTINCT btrim(ce.country)) FILTER (WHERE btrim(coalesce(ce.country, '')) <> '') AS countries
			FROM client_entities ce WHERE ce.holding_id = $1`,
			[holdingId]
		);

		return {
			total: toNumber(row?.total),
			unassigned: toNumber(row?.unassigned),
			countries: [...((row?.countries as string[] | null) ?? [])].sort((a, b) => a.localeCompare(b, 'es')),
		};
	}

	/**
	 * Vincula razones sociales a un cliente comercial del mismo holding. Omite las ya vinculadas.
	 * `makePrimaryIfNone`: si el cliente no tiene razón social principal, la primera pasa a serlo.
	 */
	async assignEntities(holdingId: string, clientId: string, entityIds: string[], makePrimaryIfNone = true) {
		const [client] = await this.dataSource.query<Row[]>(`SELECT id FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId]);

		if (!client) throw new NotFoundException('Cliente no encontrado');

		const found = await this.dataSource.query<Row[]>(`SELECT id FROM client_entities WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
			entityIds,
			holdingId,
		]);

		if (found.length !== new Set(entityIds).size) throw new BadRequestException('Alguna razón social no existe o no pertenece al holding');

		return await this.dataSource.transaction(async (manager) => {
			const [{ has_primary: hasPrimary }] = await manager.query<Row[]>(
				`SELECT EXISTS (SELECT 1 FROM client_entity_clients WHERE client_id = $1 AND is_primary) AS has_primary`,
				[clientId]
			);
			const inserted = await manager.query<Row[]>(
				`INSERT INTO client_entity_clients (client_entity_id, client_id, holding_id, is_primary)
				SELECT e.id, $1, $2, false FROM unnest($3::uuid[]) AS e(id)
				WHERE NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = e.id AND x.client_id = $1)
				RETURNING id, client_entity_id`,
				[clientId, holdingId, entityIds]
			);

			if (makePrimaryIfNone && !hasPrimary && inserted.length > 0) {
				await manager.query(`UPDATE client_entity_clients SET is_primary = true WHERE id = $1`, [inserted[0].id]);
			}

			return { assigned: inserted.length, skipped: entityIds.length - inserted.length };
		});
	}

	async listContacts(
		holdingId: string,
		{ page = 1, limit = 25, search, clientId, contactType, sortBy = 'name', sortOrder = 'asc' }: ListContactsParams
	) {
		const params: unknown[] = [holdingId];
		const filters: string[] = ['cc.holding_id = $1'];

		if (search)
			filters.push(`(cc.name ILIKE $${params.push(`%${search}%`)} OR cc.email ILIKE $${params.length} OR cc.position ILIKE $${params.length})`);
		if (clientId) filters.push(`cc.client_id = $${params.push(clientId)}`);
		if (contactType) filters.push(`cc.contact_type = $${params.push(contactType)}`);
		const where = `WHERE ${filters.join(' AND ')}`;
		const order = `${CONTACT_SORT_FIELDS[sortBy] ?? 'cc.name'} ${sortOrder === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, cc.id`;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT cc.id, cc.name, cc.position, cc.email, cc.phone, cc.contact_type, cc.client_id, c.name_commercial AS client_name
				FROM client_contacts cc LEFT JOIN clients c ON c.id = cc.client_id
				${where}
				ORDER BY ${order}
				LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`,
				params
			),
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS total FROM client_contacts cc LEFT JOIN clients c ON c.id = cc.client_id ${where}`,
				params
			),
		]);

		return paginated(
			rows.map((row) => ({
				id: row.id as string,
				name: (row.name as string) ?? null,
				position: (row.position as string) ?? null,
				email: (row.email as string) ?? null,
				phone: (row.phone as string) ?? null,
				contact_type: (row.contact_type as string) ?? null,
				client_id: (row.client_id as string) ?? null,
				client_name: (row.client_name as string) ?? null,
			})),
			toNumber(countRow?.total),
			page,
			limit
		);
	}

	async contactStats(holdingId: string) {
		const rows = await this.dataSource.query<Row[]>(
			`SELECT COALESCE(contact_type, 'Sin tipo') AS contact_type, COUNT(*) AS total FROM client_contacts WHERE holding_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
			[holdingId]
		);

		return {
			total: rows.reduce((sum, row) => sum + toNumber(row.total), 0),
			by_type: rows.map((row) => ({ contact_type: row.contact_type as string, total: toNumber(row.total) })),
		};
	}

	/** Campos editables de una razón social (lista blanca). */
	static readonly ENTITY_FIELDS = [
		'legal_name',
		'tax_id',
		'country',
		'legal_address',
		'email',
		'phone',
		'economic_activity',
		'client_number',
		'payment_terms',
	] as const;

	/** Campos editables de un contacto (lista blanca). */
	static readonly CONTACT_FIELDS = ['name', 'position', 'email', 'phone', 'contact_type', 'client_id'] as const;

	private async assertClientsInHolding(clientIds: string[], holdingId: string) {
		if (clientIds.length === 0) return;
		const found = await this.dataSource.query<Row[]>(`SELECT id FROM clients WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
			clientIds,
			holdingId,
		]);

		if (found.length !== new Set(clientIds).size) throw new NotFoundException('Cliente no encontrado');
	}

	/**
	 * Edita datos tributarios de una razón social. Si el nuevo RUT ya existe en el holding responde 409
	 * (alerta): hay duplicados legítimos (instituciones de un mismo grupo facturadas con el mismo RUT), así
	 * que el cliente puede reintentar con `allowDuplicateTaxId` tras confirmar.
	 */
	async updateEntity(
		holdingId: string,
		entityId: string,
		changes: Partial<Record<(typeof ClientDirectoryService.ENTITY_FIELDS)[number], unknown>>,
		allowDuplicateTaxId = false
	) {
		const [entity] = await this.dataSource.query<Row[]>(`SELECT id, tax_id FROM client_entities WHERE id = $1 AND holding_id = $2`, [
			entityId,
			holdingId,
		]);

		if (!entity) throw new NotFoundException('Razón social no encontrada');

		const newTaxId = typeof changes.tax_id === 'string' ? changes.tax_id.trim() : undefined;

		if (newTaxId && newTaxId !== entity.tax_id && !allowDuplicateTaxId) {
			const [duplicate] = await this.dataSource.query<Row[]>(
				`SELECT legal_name FROM client_entities WHERE holding_id = $1 AND id <> $2 AND lower(regexp_replace(tax_id, '[^0-9kK]', '', 'g')) = lower(regexp_replace($3, '[^0-9kK]', '', 'g')) LIMIT 1`,
				[holdingId, entityId, newTaxId]
			);

			if (duplicate) throw new ConflictException(`Ya existe la razón social "${duplicate.legal_name}" con ese RUT / ID tributario`);
		}

		return this.updateRow('client_entities', entityId, holdingId, ClientDirectoryService.ENTITY_FIELDS, changes);
	}

	async createContact(holdingId: string, data: Partial<Record<(typeof ClientDirectoryService.CONTACT_FIELDS)[number], string | null>>) {
		if (data.client_id) await this.assertClientsInHolding([data.client_id], holdingId);
		const fields = ClientDirectoryService.CONTACT_FIELDS.filter((field) => data[field] !== undefined);
		const values = fields.map((field) => data[field]);
		const [row] = await this.dataSource.query<Row[]>(
			`INSERT INTO client_contacts (holding_id${fields.map((field) => `, ${field}`).join('')}) VALUES ($1${fields.map((_, index) => `, $${index + 2}`).join('')}) RETURNING *`,
			[holdingId, ...values]
		);

		return row;
	}

	async updateContact(
		holdingId: string,
		contactId: string,
		changes: Partial<Record<(typeof ClientDirectoryService.CONTACT_FIELDS)[number], string | null>>
	) {
		if (changes.client_id) await this.assertClientsInHolding([changes.client_id], holdingId);

		return this.updateRow('client_contacts', contactId, holdingId, ClientDirectoryService.CONTACT_FIELDS, changes);
	}

	/** Cambios en lote sobre contactos: reasignar cliente y/o cambiar rol. */
	async bulkUpdateContacts(holdingId: string, contactIds: string[], changes: { client_id?: string; contact_type?: string }) {
		if (!changes.client_id && !changes.contact_type) throw new BadRequestException('Indica el cliente o el rol a aplicar');
		if (changes.client_id) await this.assertClientsInHolding([changes.client_id], holdingId);
		const sets: string[] = [];
		const params: unknown[] = [contactIds, holdingId];

		if (changes.client_id) sets.push(`client_id = $${params.push(changes.client_id)}`);
		if (changes.contact_type) sets.push(`contact_type = $${params.push(changes.contact_type)}`);
		const updated = await this.dataSource.query<Row[]>(
			`UPDATE client_contacts SET ${sets.join(', ')} WHERE id = ANY($1::uuid[]) AND holding_id = $2 RETURNING id`,
			params
		);

		return { updated: Array.isArray(updated[0]) ? (updated[0] as Row[]).length : updated.length };
	}

	/** UPDATE acotado al holding con columnas de lista blanca; responde la fila actualizada. */
	private async updateRow(
		table: 'client_entities' | 'client_contacts',
		id: string,
		holdingId: string,
		allowed: readonly string[],
		changes: Record<string, unknown>
	) {
		const fields = allowed.filter((field) => changes[field] !== undefined);

		if (fields.length === 0) throw new BadRequestException('No hay cambios para guardar');
		const params: unknown[] = [id, holdingId, ...fields.map((field) => changes[field])];
		const rows = await this.dataSource.query<Row[]>(
			`UPDATE ${table} SET ${fields.map((field, index) => `${field} = $${index + 3}`).join(', ')} WHERE id = $1 AND holding_id = $2 RETURNING *`,
			params
		);
		const row = Array.isArray(rows[0]) ? (rows[0] as Row[])[0] : rows[0];

		if (!row) throw new NotFoundException(table === 'client_entities' ? 'Razón social no encontrada' : 'Contacto no encontrado');

		return row;
	}
}
