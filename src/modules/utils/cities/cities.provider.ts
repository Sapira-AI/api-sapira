import { Connection } from 'mongoose';

import { CitiesSchema } from './cities.schema';

export const CitiesProviders = [
	{
		provide: 'CitiesModelToken',
		useFactory: (connection: Connection) => connection.model('Cities', CitiesSchema),
		inject: ['DbConnectionToken'],
	},
];
