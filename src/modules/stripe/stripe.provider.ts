import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

export const StripeProviders = [
	{
		provide: STRIPE_CLIENT,
		useFactory: (configService: ConfigService) => {
			const apiKey = configService.get<string>('STRIPE_SECRET_KEY');
			if (!apiKey) {
				throw new Error('STRIPE_SECRET_KEY no está configurada en las variables de entorno');
			}
			return new Stripe(apiKey, {
				apiVersion: '2026-01-28.clover',
			});
		},
		inject: [ConfigService],
	},
];
