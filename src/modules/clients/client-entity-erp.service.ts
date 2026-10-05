import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { OdooConnectionError, type OdooPartnerCandidate, OdooPartnersService } from '@/modules/odoo/odoo-partners.service';

import { ClientDirectoryService, conflict, type CreateEntityInput, type EntityBlocker } from './client-directory.service';
import { findEntitiesLinkedToPartners, partnerAlreadyLinkedMessage, type PartnerLinkedEntity } from './client-entity-writer';

type Row = Record<string, unknown>;

interface EntityRow {
	id: string;
	legal_name: string | null;
	tax_id: string | null;
	odoo_partner_id: number | null;
}

/** Candidato con la razón social del holding que ya lo usa (si hay): no se puede vincular a dos. */
export interface ErpPartnerCandidate extends OdooPartnerCandidate {
	linked_entity: PartnerLinkedEntity | null;
}

/** ¿El texto buscado es un RUT / ID tributario (5 dígitos o más) y no un nombre? */
export const looksLikeTaxId = (term: string) => (term.match(/\d/g)?.length ?? 0) >= 5;

/** Qué se busca en el ERP con el texto escrito: por RUT si parece uno, si no por nombre. */
const searchedFor = (term: string) => (looksLikeTaxId(term) ? { tax_id: term, name: null } : { tax_id: null, name: term });

/** Bloqueo explicativo cuando el ERP no responde o el holding no tiene conexión (copy sin nombrar el sistema). */
export function odooBlocker(error: unknown): EntityBlocker {
	if (error instanceof OdooConnectionError && error.reason === 'no_connection')
		return {
			code: 'odoo_not_connected',
			message: 'El holding no tiene una integración de ERP configurada y activa.',
			next_step: 'Configura la conexión en Configuración › Integraciones o pídeselo a soporte.',
		};
	if (error instanceof OdooConnectionError)
		return {
			code: 'odoo_auth_failed',
			message: 'El ERP rechazó las credenciales de la conexión del holding.',
			next_step: 'Revisa el usuario y la API key de la conexión en Configuración › Integraciones.',
		};

	return {
		code: 'odoo_unavailable',
		message: 'El ERP no respondió a la búsqueda.',
		next_step: 'Vuelve a intentarlo en unos minutos; si persiste, avisa a soporte.',
	};
}

/** 503 con el bloqueo explicativo (el ERP no respondió al validar el partner). */
function erpUnavailable(error: unknown) {
	const blocker = odooBlocker(error);

	return Object.assign(
		new ServiceUnavailableException({ message: `${blocker.message} ${blocker.next_step ?? ''}`.trim(), code: blocker.code, blockers: [blocker] }),
		{ code: blocker.code }
	);
}

/**
 * Vínculo de una razón social con su partner del ERP (`client_entities.odoo_partner_id`): buscar candidatos, vincular,
 * desvincular y crear una razón social ya vinculada ("Traer desde ERP"). La búsqueda reutiliza `OdooPartnersService` (conexión
 * activa del holding, mismas variantes de vat que la resolución automática); vincular y crear validan que el partner exista y
 * esté activo y que ninguna otra razón social del holding lo use (`findEntitiesLinkedToPartners`).
 */
@Injectable()
export class ClientEntityErpService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly odooPartners: OdooPartnersService,
		private readonly directory: ClientDirectoryService
	) {}

	private async loadEntity(holdingId: string, entityId: string): Promise<EntityRow> {
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT id, legal_name, tax_id, odoo_partner_id FROM client_entities WHERE id = $1 AND holding_id = $2`,
			[entityId, holdingId]
		);

		if (!row) throw new NotFoundException('Razón social no encontrada');

		return {
			id: String(row.id),
			legal_name: (row.legal_name as string) ?? null,
			tax_id: (row.tax_id as string) ?? null,
			odoo_partner_id: row.odoo_partner_id === null || row.odoo_partner_id === undefined ? null : Number(row.odoo_partner_id),
		};
	}

	/** Candidatos marcados con la razón social que ya los usa (no vinculables). */
	private async withLinked(holdingId: string, candidates: OdooPartnerCandidate[], exceptId: string | null) {
		const linked = await findEntitiesLinkedToPartners(
			this.dataSource,
			holdingId,
			candidates.map((candidate) => candidate.odoo_partner_id),
			exceptId
		);

		return candidates.map<ErpPartnerCandidate>((candidate) => ({ ...candidate, linked_entity: linked.get(candidate.odoo_partner_id) ?? null }));
	}

	/** Partner activo en el ERP o error explicativo: 404 `partner_not_found` (no existe o archivado), 503 si el ERP no responde. */
	private async requireActivePartner(holdingId: string, partnerId: number): Promise<OdooPartnerCandidate> {
		let partner: OdooPartnerCandidate | null;

		try {
			partner = await this.odooPartners.findActivePartner(holdingId, partnerId);
		} catch (error) {
			throw erpUnavailable(error);
		}
		if (!partner)
			throw Object.assign(
				new NotFoundException({ message: `El cliente #${partnerId} no existe o está archivado en el ERP`, code: 'partner_not_found' }),
				{ code: 'partner_not_found' }
			);

		return partner;
	}

	/** 409 `partner_already_linked` si otra razón social del holding usa el partner (dice cuál y de qué cliente). */
	private async assertPartnerFree(holdingId: string, partnerId: number, exceptId: string | null) {
		const other = (await findEntitiesLinkedToPartners(this.dataSource, holdingId, [partnerId], exceptId)).get(partnerId);

		if (other) throw conflict('partner_already_linked', partnerAlreadyLinkedMessage(other), { linked_entity: other });
	}

	/**
	 * ¿El holding tiene una integración de ERP activa? Solo lee la configuración (no llama al ERP). `name` = nombre de la
	 * conexión, para nombrar el sistema sin escribirlo a mano en la interfaz.
	 */
	async connection(holdingId: string) {
		const { connected, name } = await this.odooPartners.connectionStatus(holdingId);

		return { connected, name };
	}

	/** Partner vinculado hoy, leído en el ERP (nombre, RUT, país; `archived` si ya no está activo). Si el ERP no responde, `blockers`. */
	async current(holdingId: string, entityId: string) {
		const entity = await this.loadEntity(holdingId, entityId);

		if (!entity.odoo_partner_id) return { current: null, blockers: [] as EntityBlocker[] };
		try {
			const partner = await this.odooPartners.findActivePartner(holdingId, entity.odoo_partner_id);

			return {
				current: partner ? { ...partner, archived: false } : { odoo_partner_id: entity.odoo_partner_id, name: null, archived: true },
				blockers: [] as EntityBlocker[],
			};
		} catch (error) {
			return { current: { odoo_partner_id: entity.odoo_partner_id, name: null, archived: false }, blockers: [odooBlocker(error)] };
		}
	}

	/**
	 * Candidatos del ERP para la razón social. Sin `query`: por su RUT y, si no aparece nada, por su nombre. Con `query`:
	 * por RUT si parece uno (5 dígitos o más), si no por nombre. Si el ERP no responde, `blockers` lo explica (200).
	 */
	async search(holdingId: string, entityId: string, query?: string) {
		const entity = await this.loadEntity(holdingId, entityId);
		const term = query?.trim() || '';
		const searched = term ? searchedFor(term) : { tax_id: entity.tax_id, name: null as string | null };
		let candidates: OdooPartnerCandidate[] = [];
		let current: (OdooPartnerCandidate & { archived: boolean }) | { odoo_partner_id: number; archived: boolean; name: null } | null = null;
		const blockers: EntityBlocker[] = [];

		try {
			candidates =
				searched.tax_id || searched.name
					? await this.odooPartners.findPartnerCandidates(holdingId, { taxId: searched.tax_id, name: searched.name })
					: [];
			if (!term && candidates.length === 0 && entity.legal_name?.trim()) {
				searched.name = entity.legal_name.trim();
				candidates = await this.odooPartners.findPartnerCandidates(holdingId, { name: searched.name });
			}
			if (entity.odoo_partner_id) {
				const partner = await this.odooPartners.findActivePartner(holdingId, entity.odoo_partner_id);

				current = partner ? { ...partner, archived: false } : { odoo_partner_id: entity.odoo_partner_id, archived: true, name: null };
			}
		} catch (error) {
			blockers.push(odooBlocker(error));
			if (entity.odoo_partner_id) current = { odoo_partner_id: entity.odoo_partner_id, archived: false, name: null };
		}

		return {
			entity: { id: entity.id, legal_name: entity.legal_name, tax_id: entity.tax_id },
			current,
			searched,
			candidates: await this.withLinked(holdingId, candidates, entity.id),
			blockers,
		};
	}

	/**
	 * "Traer desde ERP": candidatos para una razón social que todavía no existe en Sapira, por RUT (si el texto parece uno) o
	 * por nombre. Misma búsqueda y mismas marcas `linked_entity` que `search`; si el ERP no responde, `blockers` (200).
	 */
	async searchForNew(holdingId: string, query: string) {
		const searched = searchedFor(query.trim());
		let candidates: OdooPartnerCandidate[] = [];
		const blockers: EntityBlocker[] = [];

		try {
			candidates = await this.odooPartners.findPartnerCandidates(holdingId, { taxId: searched.tax_id, name: searched.name });
		} catch (error) {
			blockers.push(odooBlocker(error));
		}

		return { searched, candidates: await this.withLinked(holdingId, candidates, null), blockers };
	}

	/**
	 * Vincula el partner. 409 `partner_already_linked` si otra razón social del holding lo usa (dice cuál); 404
	 * `partner_not_found` si no existe o está archivado en la conexión del holding; 503 si el ERP no responde.
	 */
	async link(holdingId: string, entityId: string, partnerId: number) {
		const entity = await this.loadEntity(holdingId, entityId);

		await this.assertPartnerFree(holdingId, partnerId, entity.id);
		const partner = await this.requireActivePartner(holdingId, partnerId);

		await withApiWriter(this.dataSource, (runner) =>
			runner.query(`UPDATE client_entities SET odoo_partner_id = $3 WHERE id = $1 AND holding_id = $2`, [entity.id, holdingId, partnerId])
		);

		return { client_entity_id: entity.id, previous_odoo_partner_id: entity.odoo_partner_id, partner };
	}

	/**
	 * Alta "Traer desde ERP": crea la razón social ya vinculada al partner en una sola transacción (`createEntity` con
	 * `odooPartnerId`, que repite la regla de unicidad dentro de la transacción). Antes valida: partner libre (409
	 * `partner_already_linked`, sin consultar el ERP) y activo en el ERP (404 / 503). El RUT duplicado sigue la regla de siempre
	 * (409 `duplicate_tax_id` salvo `allowDuplicateTaxId`).
	 */
	async createWithPartner(holdingId: string, data: CreateEntityInput, partnerId: number, allowDuplicateTaxId = false) {
		await this.assertPartnerFree(holdingId, partnerId, null);
		await this.requireActivePartner(holdingId, partnerId);

		return this.directory.createEntity(holdingId, data, allowDuplicateTaxId, { odooPartnerId: partnerId });
	}

	/** Quita el vínculo (las facturas de esta razón social dejan de enviarse al ERP hasta que se vuelva a vincular). */
	async unlink(holdingId: string, entityId: string) {
		const entity = await this.loadEntity(holdingId, entityId);

		if (entity.odoo_partner_id !== null)
			await withApiWriter(this.dataSource, (runner) =>
				runner.query(`UPDATE client_entities SET odoo_partner_id = NULL WHERE id = $1 AND holding_id = $2`, [entity.id, holdingId])
			);

		return { client_entity_id: entity.id, previous_odoo_partner_id: entity.odoo_partner_id };
	}
}
