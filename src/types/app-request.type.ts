import { Request as ExpressRequest } from 'express';

import { UserResponseDto } from '@/modules/users/dtos/users.dto';

export type AppRequest = ExpressRequest & { user?: UserResponseDto };
