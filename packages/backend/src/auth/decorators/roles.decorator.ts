import { SetMetadata } from '@nestjs/common';

export type UserRole = 'Owner' | 'Admin' | 'Engineer' | 'Viewer';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
