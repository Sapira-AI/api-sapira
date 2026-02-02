import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateOdooConnectionDto, UpdateOdooConnectionDto } from './dtos/odoo-connection.dto';
import { OdooConnection } from './entities/odoo-connection.entity';

@Injectable()
export class OdooConnectionService {
	constructor(
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>
	) {}

	async findAll(): Promise<OdooConnection[]> {
		return await this.odooConnectionRepository.find({
			order: { created_at: 'DESC' },
		});
	}

	async findByHoldingId(holdingId: string): Promise<OdooConnection[]> {
		return await this.odooConnectionRepository.find({
			where: { holding_id: holdingId },
			order: { created_at: 'DESC' },
		});
	}

	async findOne(id: string): Promise<OdooConnection> {
		const connection = await this.odooConnectionRepository.findOne({
			where: { id },
		});

		if (!connection) {
			throw new NotFoundException(`Conexión Odoo con id ${id} no encontrada`);
		}

		return connection;
	}

	async create(createDto: CreateOdooConnectionDto): Promise<OdooConnection> {
		const connection = this.odooConnectionRepository.create(createDto);
		return await this.odooConnectionRepository.save(connection);
	}

	async update(id: string, updateDto: UpdateOdooConnectionDto): Promise<OdooConnection> {
		const connection = await this.findOne(id);

		Object.assign(connection, updateDto);

		return await this.odooConnectionRepository.save(connection);
	}

	async delete(id: string): Promise<{ message: string }> {
		const connection = await this.findOne(id);

		await this.odooConnectionRepository.remove(connection);

		return { message: `Conexión Odoo ${id} eliminada exitosamente` };
	}

	async toggleActive(id: string): Promise<OdooConnection> {
		const connection = await this.findOne(id);

		connection.is_active = !connection.is_active;

		return await this.odooConnectionRepository.save(connection);
	}
}
