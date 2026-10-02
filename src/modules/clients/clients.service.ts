import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Raw, Repository } from 'typeorm';

import { ClientEntityClient } from '@/databases/postgresql/entities/clientes/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { BigQueryService } from '@/modules/bigquery/bigquery.service';
import { withApiWriter } from '@/modules/contracts/api-writer';

import { conflict, joinEs, plural } from './client-directory.service';
import { clientLifecycleSql, type ClientLifecycleStatus } from './client-lifecycle';
import { AssignEntityToClientDto } from './dtos/assign-entity.dto';
import { CreateClientDto } from './dtos/create-client.dto';
import { QueryClientsDto } from './dtos/query-clients.dto';
import { UpdateClientDto } from './dtos/update-client.dto';
import { IClientFilterOptions, IClientWithEntities, IPaginatedClients } from './interfaces/client.interface';

@Injectable()
export class ClientsService {
	private readonly logger = new Logger(ClientsService.name);

	constructor(
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		@InjectRepository(ClientEntityClient)
		private readonly clientEntityClientRepository: Repository<ClientEntityClient>,
		private readonly bigQueryService: BigQueryService
	) {}

	/** Crea el cliente en el holding activo (validado por `HoldingScopeGuard`). */
	async create(createClientDto: CreateClientDto, holdingId: string): Promise<Client> {
		const client = this.clientRepository.create({ ...createClientDto, holding_id: holdingId });
		return await this.clientRepository.save(client);
	}

	/** Clientes del holding activo (validado por `HoldingScopeGuard`). */
	async findAll(queryDto: QueryClientsDto, holdingId: string): Promise<IPaginatedClients> {
		const {
			page = 1,
			limit = 20,
			search,
			segment,
			industry,
			market,
			status,
			lifecycle,
			country,
			sort_by = 'created_at',
			sort_order = 'desc',
		} = queryDto;

		const skip = (page - 1) * limit;

		const where: any = { holding_id: holdingId };

		if (segment) {
			where.segment = segment;
		}

		if (industry) {
			where.industry = industry;
		}

		if (market) {
			where.market = market;
		}

		if (status) {
			where.status = status;
		}

		if (country) {
			where.country = country;
		}

		if (lifecycle) {
			where.id = Raw(
				(column) =>
					`${column} IN (SELECT cl.id FROM clients cl WHERE cl.holding_id = :lifecycleHolding AND (${clientLifecycleSql('cl')}) = :lifecycle)`,
				{
					lifecycleHolding: holdingId,
					lifecycle,
				}
			);
		}

		// La búsqueda encuentra por nombre comercial o por N° cliente (OR, con el resto de los filtros en ambas ramas).
		const searchWhere = search
			? [
					{ ...where, name_commercial: ILike(`%${search}%`) },
					{ ...where, client_number: ILike(`%${search}%`) },
				]
			: where;

		const [data, total] = await this.clientRepository.findAndCount({
			where: searchWhere,
			skip,
			take: limit,
			// `id` desempata para que la paginación sea estable con valores repetidos; los vacíos van al final.
			order: { [sort_by]: { direction: sort_order === 'asc' ? 'ASC' : 'DESC', nulls: 'LAST' }, id: 'ASC' },
		});

		const lifecycles = await this.lifecycleByClient(data.map((client) => client.id));

		return {
			data: data.map((client) => ({ ...client, lifecycle_status: lifecycles.get(client.id) })),
			items: total,
			pages: Math.ceil(total / limit),
			currentPage: page,
			limit,
		};
	}

	/** Valores distintos (no vacíos) de los campos filtrables de clientes del holding, para armar los filtros. */
	async getFilterOptions(holdingId: string): Promise<IClientFilterOptions> {
		const [row] = (await this.clientRepository.query(
			`SELECT
				array_agg(DISTINCT btrim(segment)) FILTER (WHERE btrim(coalesce(segment, '')) <> '') AS segment,
				array_agg(DISTINCT btrim(industry)) FILTER (WHERE btrim(coalesce(industry, '')) <> '') AS industry,
				array_agg(DISTINCT btrim(market)) FILTER (WHERE btrim(coalesce(market, '')) <> '') AS market,
				array_agg(DISTINCT btrim(country)) FILTER (WHERE btrim(coalesce(country, '')) <> '') AS country,
				array_agg(DISTINCT btrim(status)) FILTER (WHERE btrim(coalesce(status, '')) <> '') AS status
			FROM clients
			WHERE holding_id = $1`,
			[holdingId]
		)) as Array<Record<keyof IClientFilterOptions, string[] | null>>;

		const sorted = (values?: string[] | null) => [...(values ?? [])].sort((a, b) => a.localeCompare(b, 'es'));

		return {
			segment: sorted(row?.segment),
			industry: sorted(row?.industry),
			market: sorted(row?.market),
			country: sorted(row?.country),
			status: sorted(row?.status),
		};
	}

	/** Cliente por id; con `holdingId`, solo si es de ese holding (si no, 404 como si no existiera). */
	async findOne(id: string, holdingId?: string): Promise<Client> {
		const client = await this.clientRepository.findOne({
			where: { id },
		});

		if (!client || (holdingId && client.holding_id !== holdingId)) {
			throw new NotFoundException(`Cliente con id ${id} no encontrado`);
		}

		return client;
	}

	async findOneWithEntities(id: string): Promise<IClientWithEntities> {
		const client = await this.findOne(id);

		const relations = await this.clientEntityClientRepository.find({
			where: { client_id: id },
			order: { is_primary: 'DESC' },
		});

		const entityIds = relations.map((rel) => rel.client_entity_id);

		let entities: ClientEntity[] = [];
		let primary_entity: ClientEntity | undefined;

		if (entityIds.length > 0) {
			entities = await this.clientEntityRepository.findByIds(entityIds);

			const primaryRelation = relations.find((rel) => rel.is_primary);
			if (primaryRelation) {
				primary_entity = entities.find((entity) => entity.id === primaryRelation.client_entity_id);
			}
		}

		const lifecycles = await this.lifecycleByClient([client.id]);

		return {
			...client,
			lifecycle_status: lifecycles.get(client.id),
			entities,
			primary_entity,
		};
	}

	/** Estado calculado (`client-lifecycle.ts`) de cada cliente, en una sola consulta. */
	private async lifecycleByClient(ids: string[]): Promise<Map<string, ClientLifecycleStatus>> {
		if (ids.length === 0) return new Map();
		const rows = (await this.clientRepository.query(
			`SELECT cl.id, ${clientLifecycleSql('cl')} AS lifecycle FROM clients cl WHERE cl.id = ANY($1::uuid[])`,
			[ids]
		)) as Array<{
			id: string;
			lifecycle: ClientLifecycleStatus;
		}>;

		return new Map(rows.map((row) => [row.id, row.lifecycle]));
	}

	async update(id: string, updateClientDto: UpdateClientDto): Promise<Client> {
		const client = await this.findOne(id);

		Object.assign(client, updateClientDto);

		return await this.clientRepository.save(client);
	}

	/**
	 * Lo que impide eliminar un cliente comercial. Historial (contratos, facturas, facturas históricas, MRR histórico,
	 * suscripciones) y cotizaciones: sus FK no tienen cascada o la cascada borraría datos (cotizaciones `CASCADE`, facturas
	 * históricas `SET NULL`). Razones sociales creadas con este cliente (`client_entities.client_id`, columna heredada con
	 * `ON DELETE CASCADE`): se borrarían con él, así que también bloquean. Las razones sociales vinculadas solo por
	 * `client_entity_clients` no bloquean: pierden el vínculo y quedan sin cliente asignado.
	 */
	async removalUsage(id: string, holdingId: string) {
		const [row] = (await this.clientRepository.query(
			`SELECT
				(SELECT COUNT(*) FROM contracts WHERE client_id = $1) AS contracts,
				(SELECT COUNT(*) FROM invoices WHERE client_id = $1) AS invoices,
				(SELECT COUNT(*) FROM invoices_legacy WHERE client_id = $1) AS legacy_invoices,
				(SELECT COUNT(*) FROM mrr_legacy WHERE client_id = $1) AS legacy_mrr,
				(SELECT COUNT(*) FROM subscriptions WHERE client_id = $1) AS subscriptions,
				(SELECT COUNT(*) FROM quotes WHERE client_id = $1) AS quotes,
				(SELECT COUNT(*) FROM client_entities WHERE client_id = $1 AND holding_id = $2) AS owned_entities
			FROM clients WHERE id = $1 AND holding_id = $2`,
			[id, holdingId]
		)) as Array<Record<string, unknown>>;

		if (!row) throw new NotFoundException(`Cliente con id ${id} no encontrado`);
		const n = (value: unknown) => Number(value ?? 0) || 0;

		return {
			contracts: n(row.contracts),
			invoices: n(row.invoices),
			legacy_invoices: n(row.legacy_invoices),
			legacy_mrr: n(row.legacy_mrr),
			subscriptions: n(row.subscriptions),
			quotes: n(row.quotes),
			owned_entities: n(row.owned_entities),
		};
	}

	/**
	 * Elimina un cliente comercial sin uso (ver `removalUsage`): 409 `client_in_use` con los conteos si tiene historial o
	 * cotizaciones, y 409 `client_owns_entities` si borrarlo arrastraría razones sociales. Con la cascada de la base se van sus
	 * contactos, documentos, notas, configuración de agentes y vínculos con razones sociales (que quedan sin cliente asignado).
	 */
	async remove(id: string, holdingId: string): Promise<{ success: boolean; message: string }> {
		const usage = await this.removalUsage(id, holdingId);
		const parts = [
			plural(usage.contracts, 'contrato', 'contratos'),
			plural(usage.invoices, 'factura', 'facturas'),
			plural(usage.legacy_invoices, 'factura histórica', 'facturas históricas'),
			plural(usage.legacy_mrr, 'registro de MRR histórico', 'registros de MRR histórico'),
			plural(usage.subscriptions, 'suscripción', 'suscripciones'),
			plural(usage.quotes, 'cotización', 'cotizaciones'),
		].filter(Boolean);

		if (parts.length) throw conflict('client_in_use', `No se puede eliminar: tiene ${joinEs(parts)}.`, { usage });
		if (usage.owned_entities)
			throw conflict(
				'client_owns_entities',
				`No se puede eliminar: ${plural(usage.owned_entities, 'razón social se creó', 'razones sociales se crearon')} con este cliente y se borrarían con él.`,
				{ usage }
			);

		try {
			await withApiWriter(this.clientRepository.manager.connection, (runner) =>
				runner.query(`DELETE FROM clients WHERE id = $1 AND holding_id = $2`, [id, holdingId])
			);
		} catch (error) {
			// FK que la revisión no conoce (tabla nueva): se explica en vez de un 500.
			if ((error as { code?: string })?.code === '23503')
				throw conflict('client_in_use', 'No se puede eliminar: el cliente todavía está referenciado por otros registros.', { usage });
			throw error;
		}

		return {
			success: true,
			message: `Cliente ${id} eliminado exitosamente`,
		};
	}

	async assignEntity(
		clientId: string,
		assignDto: AssignEntityToClientDto,
		holdingId: string,
		userId?: string
	): Promise<{ success: boolean; message: string; relation_id: string }> {
		await this.findOne(clientId);

		const entity = await this.clientEntityRepository.findOne({
			where: { id: assignDto.client_entity_id },
		});

		if (!entity) {
			throw new NotFoundException(`Razón social con id ${assignDto.client_entity_id} no encontrada`);
		}

		if (entity.holding_id !== holdingId) {
			throw new BadRequestException('La razón social no pertenece al mismo holding que el cliente');
		}

		const existingRelation = await this.clientEntityClientRepository.findOne({
			where: {
				client_id: clientId,
				client_entity_id: assignDto.client_entity_id,
			},
		});

		if (existingRelation) {
			throw new ConflictException('Esta razón social ya está asignada al cliente');
		}

		if (assignDto.is_primary) {
			await this.clientEntityClientRepository.update({ client_id: clientId }, { is_primary: false });
		}

		const relation = this.clientEntityClientRepository.create({
			client_id: clientId,
			client_entity_id: assignDto.client_entity_id,
			holding_id: holdingId,
			is_primary: assignDto.is_primary || false,
			created_by: userId,
		});

		const savedRelation = await this.clientEntityClientRepository.save(relation);

		return {
			success: true,
			message: 'Razón social asignada exitosamente al cliente',
			relation_id: savedRelation.id,
		};
	}

	/**
	 * Quita el vínculo razón social ↔ cliente comercial (`client_entity_clients`); la razón social no se elimina. 409
	 * `entity_client_in_use` con los conteos si ESE cliente tiene contratos, facturas (también históricas) o suscripciones con
	 * ESA razón social (mismo criterio de uso que `ClientDirectoryService.deletionCheck`, acotado al par; las cotizaciones no
	 * apuntan a la razón social). Si era la principal, la siguiente más antigua del cliente pasa a serlo (misma regla que
	 * eliminar razón social). `client_entities.client_id` (columna heredada) no se toca, igual que al asignar.
	 */
	async unassignEntity(
		clientId: string,
		entityId: string,
		holdingId?: string
	): Promise<{ success: boolean; message: string; new_primary_entity_id: string | null }> {
		const client = await this.findOne(clientId, holdingId);

		const relation = await this.clientEntityClientRepository.findOne({
			where: {
				client_id: clientId,
				client_entity_id: entityId,
			},
		});

		if (!relation) {
			throw new NotFoundException('Relación no encontrada entre el cliente y la razón social');
		}

		const [row] = (await this.clientRepository.query(
			`SELECT
				(SELECT COUNT(*) FROM contracts WHERE client_id = $1 AND client_entity_id = $2) AS contracts,
				(SELECT COUNT(*) FROM invoices WHERE client_id = $1 AND client_entity_id = $2) AS invoices,
				(SELECT COUNT(*) FROM invoices_legacy WHERE client_id = $1 AND client_entity_id = $2) AS legacy_invoices,
				(SELECT COUNT(*) FROM subscriptions WHERE client_id = $1 AND client_entity_id = $2) AS subscriptions`,
			[clientId, entityId]
		)) as Array<Record<string, unknown>>;
		const n = (value: unknown) => Number(value ?? 0) || 0;
		const usage = {
			contracts: n(row?.contracts),
			invoices: n(row?.invoices),
			legacy_invoices: n(row?.legacy_invoices),
			subscriptions: n(row?.subscriptions),
		};
		const parts = [
			plural(usage.contracts, 'contrato', 'contratos'),
			plural(usage.invoices, 'factura', 'facturas'),
			plural(usage.legacy_invoices, 'factura histórica', 'facturas históricas'),
			plural(usage.subscriptions, 'suscripción', 'suscripciones'),
		].filter(Boolean);

		if (parts.length)
			throw conflict('entity_client_in_use', `No se puede desasignar: tiene ${joinEs(parts)} con este cliente.`, {
				usage,
				next_step:
					'Si la razón social está mal asignada, cámbiala en esos contratos (Modificar contrato › Cambiar razón social) y vuelve a intentarlo.',
			});

		const newPrimary = await withApiWriter(this.clientRepository.manager.connection, async (runner) => {
			await runner.query(`DELETE FROM client_entity_clients WHERE id = $1 AND client_id = $2`, [relation.id, clientId]);
			if (!relation.is_primary) return null;
			const promoted = (await runner.query(
				`UPDATE client_entity_clients SET is_primary = true WHERE id = (
					SELECT id FROM client_entity_clients WHERE client_id = $1 AND holding_id = $2 ORDER BY created_at, id LIMIT 1)
				RETURNING client_entity_id`,
				[clientId, client.holding_id]
			)) as Array<Record<string, unknown>> | [Array<Record<string, unknown>>, number];
			const rows = (Array.isArray(promoted[0]) ? promoted[0] : promoted) as Array<Record<string, unknown>>;

			return rows[0]?.client_entity_id ? String(rows[0].client_entity_id) : null;
		});

		return {
			success: true,
			message: 'Razón social desasignada exitosamente del cliente',
			new_primary_entity_id: newPrimary,
		};
	}

	async setPrimaryEntity(clientId: string, entityId: string): Promise<{ success: boolean; message: string }> {
		await this.findOne(clientId);

		const relation = await this.clientEntityClientRepository.findOne({
			where: {
				client_id: clientId,
				client_entity_id: entityId,
			},
		});

		if (!relation) {
			throw new NotFoundException('Relación no encontrada entre el cliente y la razón social');
		}

		await this.clientEntityClientRepository.update({ client_id: clientId }, { is_primary: false });

		relation.is_primary = true;
		await this.clientEntityClientRepository.save(relation);

		return {
			success: true,
			message: 'Razón social establecida como principal exitosamente',
		};
	}

	async getClientEntities(clientId: string): Promise<ClientEntity[]> {
		await this.findOne(clientId);

		const relations = await this.clientEntityClientRepository.find({
			where: { client_id: clientId },
			order: { is_primary: 'DESC' },
		});

		const entityIds = relations.map((rel) => rel.client_entity_id);

		if (entityIds.length === 0) {
			return [];
		}

		return await this.clientEntityRepository.findByIds(entityIds);
	}

	async syncStripeCustomerIds(holdingId: string): Promise<{
		success: boolean;
		message: string;
		stats: {
			totalFromBigQuery: number;
			clientsUpdated: number;
			clientsNotFound: number;
			errors: number;
		};
	}> {
		this.logger.log('Iniciando sincronización de stripe_customer_id desde BigQuery...');

		try {
			const result = await this.bigQueryService.executeQuery(holdingId, {
				query: 'SELECT * FROM `datawarehouse-a2e2.finance.sapira_stripe`',
				params: {},
			});

			const stats = {
				totalFromBigQuery: result.rows.length,
				clientsUpdated: 0,
				clientsNotFound: 0,
				errors: 0,
			};

			this.logger.log(`Registros obtenidos de BigQuery: ${result.rows.length}`);

			for (const row of result.rows) {
				try {
					const salesforceAccountId = row.salesforce_account_id;
					const stripeCustomerId = row.stripe_customer_id;

					if (!salesforceAccountId || !stripeCustomerId) {
						continue;
					}

					const client = await this.clientRepository.findOne({
						where: { salesforce_account_id: salesforceAccountId },
					});

					if (!client) {
						stats.clientsNotFound++;
						continue;
					}

					client.stripe_customer_id = stripeCustomerId;
					await this.clientRepository.save(client);
					stats.clientsUpdated++;
				} catch (error) {
					this.logger.error(`Error procesando registro: ${error.message}`);
					stats.errors++;
				}
			}

			this.logger.log(
				`Sincronización completada. Actualizados: ${stats.clientsUpdated}, No encontrados: ${stats.clientsNotFound}, Errores: ${stats.errors}`
			);

			return {
				success: true,
				message: 'Sincronización completada exitosamente',
				stats,
			};
		} catch (error) {
			this.logger.error('Error en sincronización de stripe_customer_id:', error);
			throw new BadRequestException(`Error al sincronizar stripe_customer_id: ${error.message}`);
		}
	}
}
