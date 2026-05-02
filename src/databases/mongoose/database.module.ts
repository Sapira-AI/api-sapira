import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Global()
@Module({
	imports: [
		MongooseModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: async (configService: ConfigService) => {
				const mongoUri = configService.get('MONGO_CONNECTION_STRING');
				const timezone = configService.get('TIMEZONE', 'America/Santiago');

				const getTimezoneOffset = (timeZone: string) => {
					const date = new Date();
					const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
					const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
					return (tzDate.getTime() - utcDate.getTime()) / 3600000;
				};

				return {
					uri: mongoUri,
					autoIndex: true,
					connectTimeoutMS: 30000,
					socketTimeoutMS: 480000,
					readPreference: 'primary',
					serverSelectionTimeoutMS: 30000,
					heartbeatFrequencyMS: 10000,
					retryWrites: true,
					minPoolSize: 5,
					maxPoolSize: 100,
					connectionFactory: (connection) => {
						connection.plugin((schema) => {
							if (!schema.path('createdAt')) {
								schema.add({ createdAt: Date });
							}
							if (!schema.path('updatedAt')) {
								schema.add({ updatedAt: Date });
							}

							schema.pre('save', function (next) {
								const now = new Date();
								this.updatedAt = now;
								if (!this.createdAt) {
									this.createdAt = now;
								}
								next();
							});

							schema.pre(['updateOne', 'findOneAndUpdate'], function (next) {
								const now = new Date();
								this.set({ updatedAt: now });
								next();
							});

							const transformOptions = {
								transform: function (doc, ret) {
									if (ret.createdAt) {
										const date = new Date(ret.createdAt);
										const offset = getTimezoneOffset(timezone);
										date.setHours(date.getHours() + offset);
										ret.createdAt = date.toISOString();
									}
									if (ret.updatedAt) {
										const date = new Date(ret.updatedAt);
										const offset = getTimezoneOffset(timezone);
										date.setHours(date.getHours() + offset);
										ret.updatedAt = date.toISOString();
									}
									return ret;
								},
							};

							schema.set('toJSON', transformOptions);
							schema.set('toObject', transformOptions);
						});

						connection.on('connected', () => {
							console.log('Mongoose conectado exitosamente a MongoDB');
						});

						connection.on('error', (err) => {
							console.error('Error de conexión a MongoDB:', err);
						});

						connection.on('disconnected', () => {
							console.warn('Mongoose desconectado de MongoDB');
						});

						return connection;
					},
				};
			},
			inject: [ConfigService],
		}),
	],
	providers: [
		{
			provide: 'DbConnectionToken',
			useFactory: (connection: Connection) => connection,
			inject: [getConnectionToken()],
		},
	],
	exports: [MongooseModule, 'DbConnectionToken'],
})
export class MongooseModules {}
