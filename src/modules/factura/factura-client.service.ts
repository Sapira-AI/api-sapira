import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { FacturaOAuthService } from './factura-oauth.service';

export interface ProvisionFacturaEmpresa {
	externalReference: {
		companyId: string;
		tenantId?: string;
	};
	rut: string;
	razonSocial: string;
	giro: string;
	direccion: string;
	comuna: string;
	ciudad: string;
	region?: string;
	ambienteSII?: 'certificacion' | 'produccion';
}

@Injectable()
export class FacturaClientService {
	constructor(
		private readonly config: ConfigService,
		private readonly oauth: FacturaOAuthService
	) {}

	async provisionEmpresa(empresa: ProvisionFacturaEmpresa) {
		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		if (!baseUrl) throw new Error('FACTURA_API_URL no está configurada');
		const token = await this.oauth.getAccessToken();
		return axios.post(`${baseUrl.replace(/\/$/, '')}/empresas/provision`, empresa, {
			headers: { Authorization: `Bearer ${token}` },
		});
	}
}
