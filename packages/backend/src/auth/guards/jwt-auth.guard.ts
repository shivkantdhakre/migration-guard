import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../../config/configuration';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing or malformed.');
    }

    const token = authHeader.substring(7);
    try {
      const payload = this.jwtService.verify(token, {
        secret: appConfig.jwtSecret,
      });
      request.user = {
        id: payload.sub || payload.id,
        email: payload.email,
        name: payload.name,
      };
      return true;
    } catch (err: any) {
      throw new UnauthorizedException('Invalid or expired authentication token.');
    }
  }
}
