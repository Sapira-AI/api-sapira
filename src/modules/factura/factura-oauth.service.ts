import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Alcances para emitir y consultar documentos tributarios (`FACTURA_OAUTH_DTE_SCOPE` los reemplaza). */
export const FACTURA_DTE_SCOPE_DEFAULT = 'factura:dte:read factura:dte:write';

@Injectable()
export class FacturaOAuthService {
	/** Un token por conjunto de alcances: la provisión no depende de que el cliente OAuth tenga los de DTE (y al revés). */
	private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

	constructor(private readonly config: ConfigService) {}

	/** Token de la provisión y el canal de correo (`FACTURA_OAUTH_SCOPE`, por defecto `factura:empresas:provision`). */
	async getAccessToken() {
		return this.tokenFor(this.config.get<string>('FACTURA_OAUTH_SCOPE') || 'factura:empresas:provision');
	}

	/** Token para emitir, enviar y consultar DTE (`FACTURA_OAUTH_DTE_SCOPE`, por defecto `factura:dte:read factura:dte:write`). */
	async getDteAccessToken() {
		return this.tokenFor(this.config.get<string>('FACTURA_OAUTH_DTE_SCOPE') || FACTURA_DTE_SCOPE_DEFAULT);
	}

	private async tokenFor(scope: string) {
		const cached = this.tokens.get(scope);
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		const clientId = this.config.get<string>('FACTURA_OAUTH_CLIENT_ID');
		const clientSecret = this.config.get<string>('FACTURA_OAUTH_CLIENT_SECRET');
		if (!baseUrl || !clientId || !clientSecret) throw new Error('OAuth de api-factura no está configurado');

		const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
		const { data } = await axios.post<{ access_token: string; expires_in: number }>(`${baseUrl.replace(/\/$/, '')}/oauth/token`, body, {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		const token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
		this.tokens.set(scope, token);
		return token.value;
	}
}
