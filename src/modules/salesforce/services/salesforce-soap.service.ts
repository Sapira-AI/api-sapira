import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SalesforceSoapService {
	private readonly logger = new Logger(SalesforceSoapService.name);

	constructor(private readonly httpService: HttpService) {}

	buildSoapEnvelope(username: string, password: string, securityToken: string): string {
		const passwordToken = `${password}${securityToken}`;
		return `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
              xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${this.escapeXml(username)}</n1:username>
      <n1:password>${this.escapeXml(passwordToken)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;
	}

	private escapeXml(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
	}

	private extractTag(payload: string, tagName: string): string | null {
		const match = payload.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
		return match?.[1] ?? null;
	}

	async attemptLogin(
		loginUrl: string,
		username: string,
		password: string,
		securityToken: string,
		apiVersion: string = '58.0',
		timeoutMs: number = 10000
	): Promise<{
		sessionId: string;
		serverUrl: string;
		userId: string;
	}> {
		const endpoint = `${loginUrl.replace(/\/$/, '')}/services/Soap/u/${apiVersion}`;
		const soapEnvelope = this.buildSoapEnvelope(username, password, securityToken);

		this.logger.log(`Attempting SOAP login to ${endpoint}`);

		try {
			const response = await firstValueFrom(
				this.httpService.post(endpoint, soapEnvelope, {
					headers: {
						'Content-Type': 'text/xml; charset=utf-8',
						SOAPAction: 'login',
					},
					timeout: timeoutMs,
				})
			);

			const payload = response.data;

			if (payload.includes('<faultcode>')) {
				const messageMatch = payload.match(/<faultstring>([^<]+)<\/faultstring>/);
				const message = messageMatch?.[1] ?? 'Salesforce SOAP fault';
				throw new Error(message);
			}

			const sessionId = this.extractTag(payload, 'sessionId');
			const serverUrl = this.extractTag(payload, 'serverUrl');
			const userId = this.extractTag(payload, 'userId');

			if (!sessionId || !serverUrl || !userId) {
				throw new Error('Salesforce login succeeded but response is missing required fields');
			}

			this.logger.log('✅ SOAP login successful');

			return { sessionId, serverUrl, userId };
		} catch (error: any) {
			if (error.code === 'ECONNABORTED') {
				throw new Error(`Salesforce login timed out after ${timeoutMs}ms`);
			}
			this.logger.error('❌ SOAP login failed:', error.message);
			throw error;
		}
	}
}
