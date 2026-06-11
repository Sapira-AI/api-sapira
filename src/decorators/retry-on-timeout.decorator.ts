import { Logger } from '@nestjs/common';

export interface RetryOptions {
	maxAttempts?: number;
	delayMs?: number;
	exponentialBackoff?: boolean;
	onRetry?: (attempt: number, error: Error) => void;
}

const defaultOptions: Required<RetryOptions> = {
	maxAttempts: 3,
	delayMs: 1000,
	exponentialBackoff: true,
	onRetry: () => {},
};

export function RetryOnTimeout(options: RetryOptions = {}) {
	const opts = { ...defaultOptions, ...options };
	const logger = new Logger('RetryOnTimeout');

	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: any[]) {
			let lastError: Error;

			for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
				try {
					return await originalMethod.apply(this, args);
				} catch (error) {
					lastError = error;

					const isTimeoutError =
						error.message?.includes('timeout') ||
						error.message?.includes('Connection terminated') ||
						error.code === 'ETIMEDOUT' ||
						error.code === '57014';

					if (!isTimeoutError || attempt === opts.maxAttempts) {
						throw error;
					}

					const delay = opts.exponentialBackoff ? opts.delayMs * Math.pow(2, attempt - 1) : opts.delayMs;

					logger.warn(
						`${target.constructor.name}.${propertyKey} - Intento ${attempt}/${opts.maxAttempts} falló (timeout). Reintentando en ${delay}ms...`
					);

					opts.onRetry(attempt, error);

					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}

			throw lastError;
		};

		return descriptor;
	};
}
