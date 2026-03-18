import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateStripeConnectionDto } from './dtos/create-stripe-connection.dto';
import { UpdateStripeConnectionDto } from './dtos/update-stripe-connection.dto';
import { StripeConnection } from './entities/stripe-connection.entity';

@Injectable()
export class StripeConnectionService {
	private readonly logger = new Logger(StripeConnectionService.name);

	constructor(
		@InjectRepository(StripeConnection)
		private readonly stripeConnectionRepository: Repository<StripeConnection>
	) {}

	async findAll(holdingId: string): Promise<StripeConnection[]> {
		this.logger.log(`Buscando todas las conexiones de Stripe para holding: ${holdingId}`);
		return await this.stripeConnectionRepository.find({
			where: { holding_id: holdingId },
			order: { created_at: 'DESC' },
		});
	}

	async findOne(id: string, holdingId: string): Promise<StripeConnection> {
		this.logger.log(`Buscando conexión de Stripe con ID: ${id} para holding: ${holdingId}`);
		const connection = await this.stripeConnectionRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!connection) {
			throw new NotFoundException(`Conexión de Stripe con ID ${id} no encontrada`);
		}

		return connection;
	}

	async create(createDto: CreateStripeConnectionDto): Promise<StripeConnection> {
		this.logger.log(`Creando nueva conexión de Stripe para holding: ${createDto.holding_id}`);

		const connection = this.stripeConnectionRepository.create(createDto);
		return await this.stripeConnectionRepository.save(connection);
	}

	async update(id: string, holdingId: string, updateDto: UpdateStripeConnectionDto): Promise<StripeConnection> {
		this.logger.log(`Actualizando conexión de Stripe con ID: ${id}`);

		const connection = await this.findOne(id, holdingId);

		Object.assign(connection, updateDto);

		return await this.stripeConnectionRepository.save(connection);
	}

	async remove(id: string, holdingId: string): Promise<void> {
		this.logger.log(`Eliminando conexión de Stripe con ID: ${id}`);

		const connection = await this.findOne(id, holdingId);
		await this.stripeConnectionRepository.remove(connection);
	}

	async toggleActive(id: string, holdingId: string): Promise<StripeConnection> {
		this.logger.log(`Cambiando estado activo de conexión de Stripe con ID: ${id}`);

		const connection = await this.findOne(id, holdingId);
		connection.is_active = !connection.is_active;

		return await this.stripeConnectionRepository.save(connection);
	}

	async updateLastSyncAt(id: string): Promise<void> {
		this.logger.log(`Actualizando last_sync_at para conexión: ${id}`);

		await this.stripeConnectionRepository.update(id, {
			last_sync_at: new Date(),
		});
	}
}
