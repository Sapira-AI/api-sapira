import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserHoldingResponseDto } from './dtos/holdings.dto';
import { CompanyHolding } from './entities/company-holding.entity';
import { UserHolding } from './entities/user-holding.entity';

@Injectable()
export class HoldingsService {
	constructor(
		@InjectRepository(CompanyHolding)
		private readonly companyHoldingRepository: Repository<CompanyHolding>,
		@InjectRepository(UserHolding)
		private readonly userHoldingRepository: Repository<UserHolding>
	) {}

	async getUserHoldings(userId: string): Promise<UserHoldingResponseDto[]> {
		const userHoldings = await this.userHoldingRepository.find({
			where: { user_id: userId },
			relations: ['holding'],
			order: { created_at: 'DESC' },
		});

		if (!userHoldings || userHoldings.length === 0) {
			return [];
		}

		return userHoldings.map((uh) => ({
			id: uh.holding.id,
			name: uh.holding.name,
			website: uh.holding.website,
			phone: uh.holding.phone,
			email: uh.holding.email,
			logo_url: uh.holding.logo_url,
			created_at: uh.holding.created_at,
			manual_status_change_enabled: uh.holding.manual_status_change_enabled,
			selected: uh.selected,
			is_active: uh.is_active,
		}));
	}

	async getHoldingById(holdingId: string): Promise<CompanyHolding> {
		const holding = await this.companyHoldingRepository.findOne({
			where: { id: holdingId },
		});

		if (!holding) {
			throw new NotFoundException(`Holding con id ${holdingId} no encontrado`);
		}

		return holding;
	}

	async getUserHoldingRelation(userId: string, holdingId: string): Promise<UserHolding | null> {
		return await this.userHoldingRepository.findOne({
			where: { user_id: userId, holding_id: holdingId },
			relations: ['holding'],
		});
	}

	async assignUserToAllHoldings(userId: string): Promise<{ assigned: number; skipped: number; total: number }> {
		const allHoldings = await this.companyHoldingRepository.find();

		if (!allHoldings || allHoldings.length === 0) {
			return { assigned: 0, skipped: 0, total: 0 };
		}

		let assigned = 0;
		let skipped = 0;

		for (const holding of allHoldings) {
			const existingRelation = await this.userHoldingRepository.findOne({
				where: { user_id: userId, holding_id: holding.id },
			});

			if (existingRelation) {
				skipped++;
				continue;
			}

			const userHolding = this.userHoldingRepository.create({
				user_id: userId,
				holding_id: holding.id,
			});

			await this.userHoldingRepository.save(userHolding);
			assigned++;
		}

		return {
			assigned,
			skipped,
			total: allHoldings.length,
		};
	}

	async updateSelectedHolding(userId: string, holdingId: string): Promise<{ success: boolean; message: string }> {
		// Verificar que el usuario tiene acceso a este holding
		const userHolding = await this.userHoldingRepository.findOne({
			where: { user_id: userId, holding_id: holdingId },
		});

		if (!userHolding) {
			throw new NotFoundException(`El usuario no tiene acceso al holding ${holdingId}`);
		}

		// Desmarcar todos los holdings del usuario como no seleccionados
		await this.userHoldingRepository.update({ user_id: userId }, { selected: false });

		// Marcar el holding especificado como seleccionado
		await this.userHoldingRepository.update({ user_id: userId, holding_id: holdingId }, { selected: true });

		return {
			success: true,
			message: `Holding ${holdingId} seleccionado exitosamente`,
		};
	}
}
