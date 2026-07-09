import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class BancoCentralSchemaService implements OnModuleInit {
	private readonly logger = new Logger(BancoCentralSchemaService.name);
	private ensureSchemaPromise: Promise<void> | null = null;

	constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

	async onModuleInit(): Promise<void> {
		await this.ensureSchema();
	}

	async ensureSchema(): Promise<void> {
		if (!this.ensureSchemaPromise) {
			this.ensureSchemaPromise = this.createSchemaIfNeeded().catch((error) => {
				this.ensureSchemaPromise = null;
				throw error;
			});
		}

		await this.ensureSchemaPromise;
	}

	private async createSchemaIfNeeded(): Promise<void> {
		this.logger.log('Verificando schema del módulo Banco Central');

		await this.dataSource.query(`
			CREATE TABLE IF NOT EXISTS public.indicadores_economicos (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				codigo VARCHAR(100) NOT NULL,
				nombre VARCHAR(255) NOT NULL,
				fecha DATE NOT NULL,
				valor DECIMAL(18, 6) NOT NULL,
				unidad VARCHAR(50),
				status_code VARCHAR(20) DEFAULT 'OK',
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				CONSTRAINT uq_indicadores_economicos_codigo_fecha UNIQUE (codigo, fecha)
			)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_indicadores_economicos_codigo
			ON public.indicadores_economicos (codigo)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_indicadores_economicos_fecha
			ON public.indicadores_economicos (fecha)
		`);

		await this.dataSource.query(`
			CREATE TABLE IF NOT EXISTS public.exchange_rates (
				rate_date DATE NOT NULL,
				from_currency VARCHAR(3) NOT NULL,
				to_currency VARCHAR(3) NOT NULL,
				rate NUMERIC(20, 8) NOT NULL,
				source_type VARCHAR(50) DEFAULT 'BANCOCENTRAL',
				api_source VARCHAR(100),
				is_indirect_conversion BOOLEAN DEFAULT FALSE,
				conversion_chain JSONB,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT pk_exchange_rates PRIMARY KEY (rate_date, from_currency, to_currency)
			)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_exchange_rates_currencies
			ON public.exchange_rates (from_currency, to_currency)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_exchange_rates_date
			ON public.exchange_rates (rate_date)
		`);

		await this.dataSource.query(`
			CREATE TABLE IF NOT EXISTS public.exchange_rates_monthly_avg (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				from_currency VARCHAR(3) NOT NULL,
				to_currency VARCHAR(3) NOT NULL,
				year INTEGER NOT NULL,
				month INTEGER NOT NULL,
				avg_rate NUMERIC(20, 8) NOT NULL,
				min_rate NUMERIC(20, 8) NOT NULL,
				max_rate NUMERIC(20, 8) NOT NULL,
				data_points INTEGER NOT NULL,
				calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT uq_exchange_rates_monthly_avg UNIQUE (from_currency, to_currency, year, month)
			)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_exchange_rates_monthly_avg_currencies
			ON public.exchange_rates_monthly_avg (from_currency, to_currency)
		`);

		await this.dataSource.query(`
			CREATE INDEX IF NOT EXISTS idx_exchange_rates_monthly_avg_period
			ON public.exchange_rates_monthly_avg (year, month)
		`);

		await this.dataSource.query(`
			CREATE TABLE IF NOT EXISTS public.currencies (
				code VARCHAR(3) PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				name_es VARCHAR(100),
				symbol VARCHAR(10),
				decimal_places INTEGER NOT NULL DEFAULT 2,
				is_active BOOLEAN NOT NULL DEFAULT TRUE,
				odoo_currency_id INTEGER,
				country VARCHAR(50),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);

		await this.dataSource.query(`
			INSERT INTO public.currencies (code, name, name_es, symbol, decimal_places, is_active, country)
			VALUES
				('CLP', 'Chilean Peso', 'Peso chileno', '$', 0, TRUE, 'Chile'),
				('USD', 'US Dollar', 'Dólar estadounidense', '$', 2, TRUE, 'Estados Unidos'),
				('EUR', 'Euro', 'Euro', '€', 2, TRUE, 'Unión Europea'),
				('CLF', 'Unidad de Fomento', 'Unidad de Fomento', 'UF', 2, TRUE, 'Chile'),
				('ARS', 'Argentine Peso', 'Peso argentino', '$', 2, TRUE, 'Argentina'),
				('COP', 'Colombian Peso', 'Peso colombiano', '$', 2, TRUE, 'Colombia'),
				('MXN', 'Mexican Peso', 'Peso mexicano', '$', 2, TRUE, 'México'),
				('UYU', 'Uruguayan Peso', 'Peso uruguayo', '$', 2, TRUE, 'Uruguay'),
				('BRL', 'Brazilian Real', 'Real brasileño', 'R$', 2, TRUE, 'Brasil'),
				('PEN', 'Peruvian Sol', 'Sol peruano', 'S/', 2, TRUE, 'Perú')
			ON CONFLICT (code) DO NOTHING
		`);

		this.logger.log('Schema del módulo Banco Central verificado correctamente');
	}
}
