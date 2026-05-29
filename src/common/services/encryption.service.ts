import * as crypto from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EncryptionService {
	private readonly algorithm = 'aes-256-cbc';
	private readonly key: Buffer;
	private readonly ivLength = 16;

	constructor(private configService: ConfigService) {
		const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');

		if (!encryptionKey) {
			throw new Error('ENCRYPTION_KEY must be set in environment variables');
		}

		this.key = crypto.scryptSync(encryptionKey, 'salt', 32);
	}

	encrypt(text: string): string {
		if (!text) return text;

		const iv = crypto.randomBytes(this.ivLength);
		const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

		let encrypted = cipher.update(text, 'utf8', 'hex');
		encrypted += cipher.final('hex');

		return iv.toString('hex') + ':' + encrypted;
	}

	decrypt(encryptedText: string): string {
		if (!encryptedText) return encryptedText;

		const parts = encryptedText.split(':');
		if (parts.length !== 2) {
			throw new Error('Invalid encrypted text format');
		}

		const iv = Buffer.from(parts[0], 'hex');
		const encrypted = parts[1];

		const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);

		let decrypted = decipher.update(encrypted, 'hex', 'utf8');
		decrypted += decipher.final('utf8');

		return decrypted;
	}
}
