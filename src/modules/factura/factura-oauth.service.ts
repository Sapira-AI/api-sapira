import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class FacturaOAuthService {
	private token?: { value: string; expiresAt: number };

	constructor(private readonly config: ConfigService) {}

	async getAccessToken() {
		if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		const clientId = this.config.get<string>('FACTURA_OAUTH_CLIENT_ID');
		const clientSecret = this.config.get<string>('FACTURA_OAUTH_CLIENT_SECRET');
		if (!baseUrl || !clientId || !clientSecret) throw new Error('OAuth de api-factura no está configurado');

		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: clientId,
			client_secret: clientSecret,
			scope: this.config.get<string>('FACTURA_OAUTH_SCOPE') || 'factura:empresas:provision',
		});
		const { data } = await axios.post<{ access_token: string; expires_in: number }>(`${baseUrl.replace(/\/$/, '')}/oauth/token`, body, {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
		return this.token.value;
	}
}
