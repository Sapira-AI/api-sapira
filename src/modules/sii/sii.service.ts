import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { BlobServiceClient } from '@azure/storage-blob';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { SiiCaf, SiiCertificate, SiiConfiguration } from '@/databases/postgresql/entities/sii/sii.entity';
import { FacturaClientService } from '@/modules/factura/factura-client.service';

import { CreateCafDto, IntegrateFacturaDto, ReserveFolioDto, UpdateSiiConfigurationDto } from './dtos/sii.dto';

@Injectable()
export class SiiService {
	constructor(
		@InjectRepository(Company) private readonly companies: Repository<Company>,
		@InjectRepository(SiiConfiguration) private readonly configurations: Repository<SiiConfiguration>,
		@InjectRepository(SiiCertificate) private readonly certificates: Repository<SiiCertificate>,
		@InjectRepository(SiiCaf) private readonly cafs: Repository<SiiCaf>,
		private readonly dataSource: DataSource,
		private readonly config: ConfigService,
		private readonly facturaClient: FacturaClientService
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
		const companies = await this.companies
			.createQueryBuilder('company')
			.where('company.holding_id = :holdingId', { holdingId })
			.andWhere("LOWER(TRIM(COALESCE(company.country, ''))) IN (:...countries)", { countries: ['chile', 'cl'] })
			.orderBy('company.legal_name', 'ASC')
			.getMany();
		const configurations = companies.length
			? await this.configurations.find({ where: { holding_id: holdingId, company_id: In(companies.map((company) => company.id)) } })
			: [];
		const linkedByCompany = new Map(configurations.filter((item) => item.is_enabled).map((item) => [item.company_id, item]));
		return companies.map((company) => ({
			id: company.id,
			holdingId: company.holding_id,
			legalName: company.legal_name,
			taxId: company.tax_id,
			country: company.country,
			legalAddress: company.legal_address,
			facturaStatus: linkedByCompany.has(company.id) ? 'linked' : 'not_linked',
		}));
	}

	async integrateWithFactura(authId: string, companyId: string, dto: IntegrateFacturaDto = {}) {
		const { company, holdingId } = await this.assertCompany(authId, companyId);
		const configuration = await this.configurations.findOne({ where: { company_id: company.id, holding_id: holdingId } });
		const giro = dto.business_activity || configuration?.business_activity;
		const comuna = dto.commune || configuration?.commune;
		const ciudad = dto.city || configuration?.city;
		if (!company.tax_id || !company.legal_name || !company.legal_address) {
			throw new BadRequestException('La compañía necesita RUT, razón social y dirección para integrarse con api-factura');
		}
		if (!giro || !comuna || !ciudad) {
			throw new BadRequestException('Giro, comuna y ciudad son requeridos para provisionar la empresa');
		}

		const provision = await this.facturaClient.provisionEmpresa({
			externalReference: { companyId: company.id, tenantId: holdingId },
			rut: company.tax_id,
			razonSocial: company.legal_name,
			giro,
			direccion: company.legal_address,
			comuna,
			ciudad,
			region: dto.region || configuration?.region,
			ambienteSII: dto.environment || configuration?.environment || 'certificacion',
		});
		const empresaId = provision.data?.empresaId || provision.data?.data?._id || provision.data?.data?.id;
		const savedConfiguration = await this.configurations.save(
			configuration
				? this.configurations.merge(configuration, {
						business_activity: giro,
						commune: comuna,
						city: ciudad,
						region: dto.region || configuration.region,
						environment: dto.environment || configuration.environment,
						is_enabled: true,
					})
				: this.configurations.create({
						holding_id: holdingId,
						company_id: company.id,
						business_activity: giro,
						commune: comuna,
						city: ciudad,
						region: dto.region,
						environment: dto.environment || 'certificacion',
						activity_codes: ['0'],
						enabled_document_types: [33, 34, 61],
						is_enabled: true,
					})
		);

		return { linked: true, sapiraCompanyId: company.id, empresaId, configurationId: savedConfiguration.id };
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
		const configuration = await this.configurations.preload({
			...(await this.configurations.findOne({ where: { company_id: company.id, holding_id: holdingId } })),
			holding_id: holdingId,
			company_id: company.id,
			...dto,
		});
		const savedConfiguration = await this.configurations.save(
			configuration || this.configurations.create({ holding_id: holdingId, company_id: company.id, ...dto })
		);
		if (company.tax_id && company.legal_name && dto.business_activity && company.legal_address && dto.commune && dto.city) {
			await this.facturaClient.provisionEmpresa({
				externalReference: { companyId: company.id, tenantId: holdingId },
				rut: company.tax_id,
				razonSocial: company.legal_name,
				giro: dto.business_activity,
				direccion: company.legal_address,
				comuna: dto.commune,
				ciudad: dto.city,
				region: dto.region,
				ambienteSII: dto.environment,
			});
		}
		return savedConfiguration;
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
		return this.certificates.save(
			this.certificates.create({
				configuration_id: configuration.id,
				key_vault_secret_name: secretName,
				file_name: file.originalname,
				expires_at: expiresAt,
				is_active: true,
			})
		);
	}

	async uploadCaf(authId: string, companyId: string, dto: CreateCafDto, file: Express.Multer.File) {
		if (!file) throw new BadRequestException('Archivo CAF requerido');
		const { configuration } = await this.getConfiguration(authId, companyId);
		if (!configuration) throw new BadRequestException('Guarda primero la configuración tributaria');
		const xml = file.buffer.toString('utf8');
		const start = Number(xml.match(/<RNG><D>(\d+)<\/D>/)?.[1]);
		const end = Number(xml.match(/<H>(\d+)<\/H>/)?.[1]);
		if (!Number.isInteger(start) || !Number.isInteger(end) || start > end)
			throw new BadRequestException('CAF inválido: no contiene un rango de folios válido');
		const container = this.blobContainer();
		if (!container) throw new BadRequestException('Blob Storage no disponible');
		const blobName = `sii/${configuration.holding_id}/${companyId}/caf/${dto.document_type}/${Date.now()}.xml`;
		await container.getBlockBlobClient(blobName).uploadData(file.buffer, { blobHTTPHeaders: { blobContentType: 'application/xml' } });
		return this.cafs.save(
			this.cafs.create({
				configuration_id: configuration.id,
				document_type: dto.document_type,
				blob_name: blobName,
				folio_start: start,
				folio_end: end,
				next_folio: start,
			})
		);
	}

	async reserveFolio(authId: string, dto: ReserveFolioDto) {
		const { holdingId } = await this.assertCompany(authId, dto.company_id);
		return this.dataSource.transaction(async (manager) => {
			const configuration = await manager
				.getRepository(SiiConfiguration)
				.findOne({ where: { holding_id: holdingId, company_id: dto.company_id } });
			if (!configuration?.is_enabled) throw new BadRequestException('La razón social no está habilitada para emitir DTE');
			const caf = await manager
				.getRepository(SiiCaf)
				.createQueryBuilder('caf')
				.setLock('pessimistic_write')
				.where('caf.configuration_id = :id AND caf.document_type = :type AND caf.is_active = true AND caf.next_folio <= caf.folio_end', {
					id: configuration.id,
					type: dto.document_type,
				})
				.orderBy('caf.created_at', 'ASC')
				.getOne();
			if (!caf) throw new BadRequestException('No hay folios CAF disponibles para este tipo de DTE');
			const folio = caf.next_folio++;
			await manager.getRepository(SiiCaf).save(caf);
			return { company_id: dto.company_id, document_type: dto.document_type, folio, idempotency_key: dto.idempotency_key };
		});
	}
}
