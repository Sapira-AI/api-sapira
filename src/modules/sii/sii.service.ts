import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { BlobServiceClient } from '@azure/storage-blob';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Company } from '@/modules/odoo/entities/companies.entity';

import { CreateCafDto, ReserveFolioDto, UpdateSiiConfigurationDto } from './dtos/sii.dto';
import { SiiCaf, SiiCertificate, SiiConfiguration } from './entities/sii.entity';

@Injectable()
export class SiiService {
	constructor(
		@InjectRepository(Company) private readonly companies: Repository<Company>,
		@InjectRepository(SiiConfiguration) private readonly configurations: Repository<SiiConfiguration>,
		@InjectRepository(SiiCertificate) private readonly certificates: Repository<SiiCertificate>,
		@InjectRepository(SiiCaf) private readonly cafs: Repository<SiiCaf>,
		private readonly dataSource: DataSource,
		private readonly config: ConfigService
	) {}

	private async selectedHolding(authId: string) {
		const [row] = await this.dataSource.query<{ holding_id: string }[]>(
			`SELECT uh.holding_id FROM user_holdings uh JOIN users u ON u.id = uh.user_id
			 WHERE u.auth_id = $1 AND uh.selected = true AND uh.is_active = true LIMIT 1`,
			[authId]
		);
		if (!row) throw new ForbiddenException('No existe un holding seleccionado');
		return row.holding_id;
	}

	private async assertCompany(authId: string, companyId: string) {
		const holdingId = await this.selectedHolding(authId);
		const company = await this.companies.findOne({ where: { id: companyId, holding_id: holdingId } });
		if (!company || !['chile', 'cl'].includes((company.country || '').trim().toLowerCase())) {
			throw new NotFoundException('Razón social chilena no encontrada en el holding seleccionado');
		}
		return { company, holdingId };
	}

	async eligibleCompanies(authId: string) {
		const holdingId = await this.selectedHolding(authId);
		return this.companies
			.createQueryBuilder('company')
			.where('company.holding_id = :holdingId', { holdingId })
			.andWhere('LOWER(TRIM(COALESCE(company.country, \'\'))) IN (:...countries)', { countries: ['chile', 'cl'] })
			.orderBy('company.legal_name', 'ASC')
			.getMany();
	}

	async getConfiguration(authId: string, companyId: string) {
		const { company, holdingId } = await this.assertCompany(authId, companyId);
		const configuration = await this.configurations.findOne({ where: { company_id: company.id, holding_id: holdingId } });
		if (!configuration) return { company, configuration: null, certificate: null, cafs: [] };
		const [certificate, cafs] = await Promise.all([
			this.certificates.findOne({ where: { configuration_id: configuration.id, is_active: true } }),
			this.cafs.find({ where: { configuration_id: configuration.id }, order: { document_type: 'ASC', created_at: 'DESC' } }),
		]);
		return { company, configuration, certificate: certificate ? { ...certificate, key_vault_secret_name: undefined } : null, cafs };
	}

	async updateConfiguration(authId: string, companyId: string, dto: UpdateSiiConfigurationDto) {
		const { company, holdingId } = await this.assertCompany(authId, companyId);
		const configuration = await this.configurations.preload({ ...(await this.configurations.findOne({ where: { company_id: company.id, holding_id: holdingId } })), holding_id: holdingId, company_id: company.id, ...dto });
		return this.configurations.save(configuration || this.configurations.create({ holding_id: holdingId, company_id: company.id, ...dto }));
	}

	private keyVault() {
		const url = this.config.get<string>('AZURE_KEY_VAULT_URL');
		if (!url) throw new BadRequestException('Azure Key Vault no está configurado');
		return new SecretClient(url, new DefaultAzureCredential());
	}

	private blobContainer() {
		const url = this.config.get<string>('AZURE_STORAGE_ACCOUNT_URL');
		const name = this.config.get<string>('SII_BLOB_CONTAINER');
		if (!url || !name) throw new BadRequestException('Azure Blob Storage SII no está configurado');
		return new BlobServiceClient(url, new DefaultAzureCredential()).getContainerClient(name);
	}

	async uploadCertificate(authId: string, companyId: string, file: Express.Multer.File, password: string, expiresAt?: string) {
		if (!file || !password) throw new BadRequestException('Certificado y contraseña son requeridos');
		const { configuration } = await this.getConfiguration(authId, companyId);
		if (!configuration) throw new BadRequestException('Guarda primero la configuración tributaria');
		const secretName = `sii-${configuration.id}-certificate-${Date.now()}`;
		await this.keyVault().setSecret(secretName, JSON.stringify({ pfx: file.buffer.toString('base64'), password }));
		await this.certificates.update({ configuration_id: configuration.id }, { is_active: false });
		return this.certificates.save(this.certificates.create({ configuration_id: configuration.id, key_vault_secret_name: secretName, file_name: file.originalname, expires_at: expiresAt, is_active: true }));
	}

	async uploadCaf(authId: string, companyId: string, dto: CreateCafDto, file: Express.Multer.File) {
		if (!file) throw new BadRequestException('Archivo CAF requerido');
		const { configuration } = await this.getConfiguration(authId, companyId);
		if (!configuration) throw new BadRequestException('Guarda primero la configuración tributaria');
		const xml = file.buffer.toString('utf8');
		const start = Number(xml.match(/<RNG><D>(\d+)<\/D>/)?.[1]);
		const end = Number(xml.match(/<H>(\d+)<\/H>/)?.[1]);
		if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new BadRequestException('CAF inválido: no contiene un rango de folios válido');
		const container = this.blobContainer();
		if (!container) throw new BadRequestException('Blob Storage no disponible');
		const blobName = `sii/${configuration.holding_id}/${companyId}/caf/${dto.document_type}/${Date.now()}.xml`;
		await container.getBlockBlobClient(blobName).uploadData(file.buffer, { blobHTTPHeaders: { blobContentType: 'application/xml' } });
		return this.cafs.save(this.cafs.create({ configuration_id: configuration.id, document_type: dto.document_type, blob_name: blobName, folio_start: start, folio_end: end, next_folio: start }));
	}

	async reserveFolio(authId: string, dto: ReserveFolioDto) {
		const { holdingId } = await this.assertCompany(authId, dto.company_id);
		return this.dataSource.transaction(async (manager) => {
			const configuration = await manager.getRepository(SiiConfiguration).findOne({ where: { holding_id: holdingId, company_id: dto.company_id } });
			if (!configuration?.is_enabled) throw new BadRequestException('La razón social no está habilitada para emitir DTE');
			const caf = await manager.getRepository(SiiCaf).createQueryBuilder('caf').setLock('pessimistic_write')
				.where('caf.configuration_id = :id AND caf.document_type = :type AND caf.is_active = true AND caf.next_folio <= caf.folio_end', { id: configuration.id, type: dto.document_type })
				.orderBy('caf.created_at', 'ASC').getOne();
			if (!caf) throw new BadRequestException('No hay folios CAF disponibles para este tipo de DTE');
			const folio = caf.next_folio++;
			await manager.getRepository(SiiCaf).save(caf);
			return { company_id: dto.company_id, document_type: dto.document_type, folio, idempotency_key: dto.idempotency_key };
		});
	}
}
