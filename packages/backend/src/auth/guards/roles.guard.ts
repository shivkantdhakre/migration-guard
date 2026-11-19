import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';
import { DatabaseService } from '../../database/database.service';

const ROLE_RANKS: Record<UserRole, number> = {
  Owner: 4,
  Admin: 3,
  Engineer: 2,
  Viewer: 1,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || !user.id) {
      throw new UnauthorizedException('Authentication required for role verification.');
    }

    // Determine workspaceId from params, headers, or query
    const workspaceId =
      request.params.workspaceId ||
      request.headers['x-workspace-id'] ||
      request.query.workspaceId;

    if (!workspaceId) {
      // If no workspace context specified on route, allow authenticated user if role matches directly
      return true;
    }

    // Check membership in workspace
    const res = await this.db.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, user.id],
    );

    if (res.rows.length === 0) {
      throw new ForbiddenException('User is not a member of the requested workspace.');
    }

    const memberRole = res.rows[0].role as UserRole;
    const userRank = ROLE_RANKS[memberRole] || 0;

    const minRequiredRank = Math.min(...requiredRoles.map((r) => ROLE_RANKS[r] || 0));

    if (userRank < minRequiredRank) {
      throw new ForbiddenException(
        `Insufficient privileges. Required: ${requiredRoles.join(', ')}. Found: ${memberRole}`,
      );
    }

    request.user.role = memberRole;
    request.user.workspaceId = workspaceId;

    return true;
  }
}
