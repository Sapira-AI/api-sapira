import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';

import type { QueryRunner } from 'typeorm';

type Row = Record<string, unknown>;

/** Razón social nueva ligada a un cliente comercial (alta desde Cliente 360 y `change_entity` con `new_entity`). */
export interface NewClientEntity {
	client_id: string;
	legal_name: string;
	tax_id: string;
	country: string;
	address: string | null;
	email: string | null;
	payment_terms: PaymentTerms | null;
	phone?: string | null;
	economic_activity?: string | null;
	client_number?: string | null;
	/** Partner del ERP con el que nace vinculada ("Traer desde ERP"); el que llama ya validó que exista y esté libre. */
	odoo_partner_id?: number | null;
}

/** Columnas opcionales que solo viajan si traen valor (el alta desde un contrato no las usa). */
const EXTRA_COLUMNS = ['phone', 'economic_activity', 'client_number', 'odoo_partner_id'] as const;

/**
 * Único camino que crea una razón social en la API: `client_entities` + su vínculo en `client_entity_clients`
 * (`is_primary = false`). Corre dentro de la transacción del que llama (que ya fijó `setApiWriter`).
 * `makePrimaryIfNone`: si el cliente no tiene razón social principal, esta pasa a serlo (mismo criterio que asignar).
 */
export async function insertClientEntity(
	runner: Pick<QueryRunner, 'query'>,
	holdingId: string,
	entity: NewClientEntity,
	{ makePrimaryIfNone = false }: { makePrimaryIfNone?: boolean } = {}
): Promise<string> {
	const extras = EXTRA_COLUMNS.filter((column) => entity[column] !== undefined && entity[column] !== null && entity[column] !== '');
	const columns = ['holding_id', 'client_id', 'legal_name', 'tax_id', 'country', 'legal_address', 'email', 'payment_terms', ...extras];
	const values: unknown[] = [
		holdingId,
		entity.client_id,
		entity.legal_name,
		entity.tax_id,
		entity.country,
		entity.address,
		entity.email,
		entity.payment_terms ? JSON.stringify(entity.payment_terms) : null,
		...extras.map((column) => entity[column]),
	];
	const placeholders = columns.map((column, index) => (column === 'payment_terms' ? `$${index + 1}::jsonb` : `$${index + 1}`));
	const [row] = (await runner.query(
		`INSERT INTO client_entities (${columns.join(', ')})\n\t\tVALUES (${placeholders.join(', ')}) RETURNING id`,
		values
	)) as Row[];
	const entityId = String(row.id);
	const links = (await runner.query(
		`INSERT INTO client_entity_clients (client_entity_id, client_id, holding_id, is_primary) VALUES ($1, $2, $3, false)
		ON CONFLICT (client_entity_id, client_id) DO NOTHING RETURNING id`,
		[entityId, entity.client_id, holdingId]
	)) as Row[];

	if (makePrimaryIfNone && links?.[0]?.id) {
		await runner.query(
			`UPDATE client_entity_clients SET is_primary = true
			WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_id = $2 AND x.holding_id = $3 AND x.is_primary)`,
			[links[0].id, entity.client_id, holdingId]
		);
	}

	return entityId;
}

/** Razón social que ya usa un partner del ERP, con su cliente comercial (para decir a cuál está vinculado). */
export interface PartnerLinkedEntity {
	id: string;
	legal_name: string | null;
	client_name: string | null;
}

/**
 * Razones sociales del holding que ya usan esos partners del ERP (`client_entities.odoo_partner_id`), una por partner.
 * Regla de unicidad del vínculo: un partner no se vincula a dos razones sociales. `exceptId`: la que se está vinculando.
 * La usan buscar/vincular y el alta "Traer desde ERP" (que la repite dentro de su transacción).
 */
export async function findEntitiesLinkedToPartners(
	db: { query: (sql: string, params: unknown[]) => Promise<unknown> },
	holdingId: string,
	partnerIds: number[],
	exceptId: string | null = null
): Promise<Map<number, PartnerLinkedEntity>> {
	const linked = new Map<number, PartnerLinkedEntity>();

	if (!partnerIds.length) return linked;
	const rows = (await db.query(
		`SELECT ce.id, ce.legal_name, ce.odoo_partner_id, c.name_commercial AS client_name FROM client_entities ce LEFT JOIN clients c ON c.id = ce.client_id WHERE ce.holding_id = $1 AND ce.odoo_partner_id = ANY($2::int[]) AND ($3::uuid IS NULL OR ce.id <> $3) ORDER BY ce.legal_name`,
		[holdingId, partnerIds, exceptId]
	)) as Row[];

	for (const row of rows ?? []) {
		const partnerId = Number(row.odoo_partner_id);

		if (!linked.has(partnerId))
			linked.set(partnerId, {
				id: String(row.id),
				legal_name: (row.legal_name as string) ?? null,
				client_name: (row.client_name as string) ?? null,
			});
	}

	return linked;
}

/** Mensaje de "partner ya vinculado": nombra la razón social y su cliente comercial. */
export const partnerAlreadyLinkedMessage = (other: PartnerLinkedEntity) =>
	`Ese cliente del ERP ya está vinculado a la razón social "${other.legal_name ?? 'sin nombre'}"${other.client_name ? ` del cliente ${other.client_name}` : ''}. Un cliente del ERP no se puede vincular a dos razones sociales.`;

/**
 * Razón social del holding con el mismo RUT / ID tributario (misma regla del PATCH y del contrato:
 * `lower(regexp_replace(tax_id, '[^0-9kK]', '', 'g'))`). `excludeId`: la que se está editando.
 */
export async function findEntityWithTaxId(
	db: { query: (sql: string, params: unknown[]) => Promise<unknown> },
	holdingId: string,
	taxId: string,
	excludeId: string | null = null
): Promise<{ id: string; legal_name: string | null } | null> {
	const rows = (await db.query(
		`SELECT id, legal_name FROM client_entities WHERE holding_id = $1 AND ($2::uuid IS NULL OR id <> $2) AND lower(regexp_replace(tax_id, '[^0-9kK]', '', 'g')) = lower(regexp_replace($3, '[^0-9kK]', '', 'g')) LIMIT 1`,
		[holdingId, excludeId, taxId]
	)) as Row[];
	const row = rows?.[0];

	return row ? { id: String(row.id), legal_name: (row.legal_name as string) ?? null } : null;
}
