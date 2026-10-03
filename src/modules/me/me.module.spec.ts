import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';

import { MeController } from './me.controller';
import { MeModule } from './me.module';
import { MeService } from './me.service';

/** Cableado de Nest: `MeModule` resuelve sus dependencias (DataSource, ConfigService y ThrottlerStorage globales, como en `AppModule`). */
@Global()
@Module({ providers: [{ provide: DataSource, useValue: { query: jest.fn() } }], exports: [DataSource] })
class FakeDatabaseModule {}

describe('MeModule · cableado', () => {
	it('compila con sus providers y el controlador', async () => {
		process.env.SUPABASE_URL ??= 'https://sb.example';
		process.env.SUPABASE_ANON_KEY ??= 'anon';
		const moduleRef = await Test.createTestingModule({
			imports: [
				ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
				FakeDatabaseModule,
				ThrottlerModule.forRoot([{ name: 'short', ttl: 60_000, limit: 10 }]),
				MeModule,
			],
		}).compile();

		expect(moduleRef.get(MeService)).toBeInstanceOf(MeService);
		expect(moduleRef.get(MeController)).toBeInstanceOf(MeController);
		await moduleRef.close();
	});
});
