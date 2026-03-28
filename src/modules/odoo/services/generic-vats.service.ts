import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GenericExportVat } from '@/databases/postgresql/entities/generic-export-vat.entity';

@Injectable()
export class GenericVatsService {
	private readonly logger = new Logger(GenericVatsService.name);
	private cache: Set<string> = new Set();
	private lastRefresh: Date | null = null;
	private readonly CACHE_TTL = 5 * 60 * 1000;

	constructor(
		@InjectRepository(GenericExportVat)
		private readonly genericVatsRepository: Repository<GenericExportVat>
	) {
		this.refreshCache();
	}

	async isGenericExportVat(vat: string | null | undefined): Promise<boolean> {
		if (!vat) {
			return false;
		}

		if (this.shouldRefreshCache()) {
			await this.refreshCache();
		}

		const normalizedVat = vat.trim().toUpperCase();
		return this.cache.has(normalizedVat);
	}

	async refreshCache(): Promise<void> {
		try {
			const vats = await this.genericVatsRepository.find({
				where: { is_active: true },
				select: ['vat'],
			});

			this.cache = new Set(vats.map((v) => v.vat.trim().toUpperCase()));
			this.lastRefresh = new Date();

			this.logger.log(`✅ Caché de VATs genéricos actualizado: ${this.cache.size} VATs cargados`);
		} catch (error) {
			this.logger.error('❌ Error al refrescar caché de VATs genéricos:', error);
		}
	}

	private shouldRefreshCache(): boolean {
		if (!this.lastRefresh) {
			return true;
		}
		return Date.now() - this.lastRefresh.getTime() > this.CACHE_TTL;
	}

	getCachedVats(): string[] {
		return Array.from(this.cache);
	}
}
