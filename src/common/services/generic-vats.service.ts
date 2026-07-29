import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GenericExportVat } from '@/databases/postgresql/entities/generic-export-vat.entity';

@Injectable()
export class GenericVatsService {
	private readonly logger = new Logger(GenericVatsService.name);
	private cache: Set<string> = new Set();
	private lastRefresh: Date | null = null;
	private readonly cacheTtl = 5 * 60 * 1000;

	constructor(
		@InjectRepository(GenericExportVat)
		private readonly genericVatsRepository: Repository<GenericExportVat>
	) {
		this.refreshCache();
	}

	async isGenericExportVat(vat: string | null | undefined): Promise<boolean> {
		const normalizedVat = this.normalizeVat(vat);
		if (!normalizedVat) {
			return false;
		}

		if (this.shouldRefreshCache()) {
			await this.refreshCache();
		}

		return this.cache.has(normalizedVat);
	}

	async refreshCache(): Promise<void> {
		try {
			const vats = await this.genericVatsRepository.find({
				where: { is_active: true },
				select: ['vat'],
			});

			this.cache = new Set(vats.map((entry) => this.normalizeVat(entry.vat)).filter((vat): vat is string => !!vat));
			this.lastRefresh = new Date();
			this.logger.log(`VATs genéricos cargados: ${this.cache.size}`);
		} catch (error) {
			this.logger.error('Error al actualizar la caché de VATs genéricos', error);
		}
	}

	private normalizeVat(vat: string | null | undefined): string | null {
		if (vat === null || vat === undefined) {
			return null;
		}

		const normalized = String(vat).replace(/[\s.]+/gu, '').toUpperCase();
		return normalized || null;
	}

	private shouldRefreshCache(): boolean {
		return !this.lastRefresh || Date.now() - this.lastRefresh.getTime() > this.cacheTtl;
	}
}
