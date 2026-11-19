import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConnectionService, CreateConnectionDto } from './connection.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class ConnectionController {
  constructor(private readonly connectionService: ConnectionService) {}

  @Get('workspaces/:workspaceId/connections')
  async listConnections(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.connectionService.listConnections(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/connections')
  async createConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateConnectionDto,
  ) {
    return this.connectionService.createConnection(workspaceId, body, user.id);
  }

  @Get('connections/:connectionId')
  async getConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
  ) {
    return this.connectionService.getConnection(connectionId, user.id);
  }

  @Patch('connections/:connectionId')
  async updateConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
    @Body() body: { name?: string; config?: Record<string, any> },
  ) {
    return this.connectionService.updateConnection(connectionId, body, user.id);
  }

  @Post('connections/:connectionId/rotate-credentials')
  @HttpCode(HttpStatus.OK)
  async rotateCredentials(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
    @Body() body: { credentials: Record<string, any> },
  ) {
    return this.connectionService.rotateCredentials(connectionId, body.credentials, user.id);
  }

  @Post('connections/:connectionId/test')
  @HttpCode(HttpStatus.OK)
  async testConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
  ) {
    return this.connectionService.testConnection(connectionId, user.id);
  }

  @Delete('connections/:connectionId')
  async deleteConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
  ) {
    return this.connectionService.deleteConnection(connectionId, user.id);
  }
}
