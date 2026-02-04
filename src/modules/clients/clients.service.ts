import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';

import { AssignEntityToClientDto } from './dtos/assign-entity.dto';
import { CreateClientDto } from './dtos/create-client.dto';
import { QueryClientsDto } from './dtos/query-clients.dto';
import { UpdateClientDto } from './dtos/update-client.dto';
import { IClientWithEntities, IPaginatedClients } from './interfaces/client.interface';

@Injectable()
export class ClientsService {
	constructor(
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		@InjectRepository(ClientEntityClient)
		private readonly clientEntityClientRepository: Repository<ClientEntityClient>
	) {}

	async create(createClientDto: CreateClientDto): Promise<Client> {
		const client = this.clientRepository.create(createClientDto);
		return await this.clientRepository.save(client);
	}

	async findAll(queryDto: QueryClientsDto): Promise<IPaginatedClients> {
		const { page = 1, limit = 20, search, holding_id, segment, industry, market, status, country } = queryDto;

		const skip = (page - 1) * limit;

		const where: any = {};

		if (holding_id) {
			where.holding_id = holding_id;
		}

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

		if (search) {
			where.name_commercial = ILike(`%${search}%`);
		}

		const [data, total] = await this.clientRepository.findAndCount({
			where,
			skip,
			take: limit,
			order: { created_at: 'DESC' },
		});

		return {
			data,
			items: total,
			pages: Math.ceil(total / limit),
			currentPage: page,
			limit,
		};
	}

	async findOne(id: string): Promise<Client> {
		const client = await this.clientRepository.findOne({
			where: { id },
		});

		if (!client) {
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

		return {
			...client,
			entities,
			primary_entity,
		};
	}

	async update(id: string, updateClientDto: UpdateClientDto): Promise<Client> {
		const client = await this.findOne(id);

		Object.assign(client, updateClientDto);

		return await this.clientRepository.save(client);
	}

	async remove(id: string): Promise<{ success: boolean; message: string }> {
		const client = await this.findOne(id);
		await this.clientRepository.remove(client);

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

	async unassignEntity(clientId: string, entityId: string): Promise<{ success: boolean; message: string }> {
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

		await this.clientEntityClientRepository.remove(relation);

		return {
			success: true,
			message: 'Razón social desasignada exitosamente del cliente',
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
}
