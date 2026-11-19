import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../auth/decorators/roles.decorator';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get()
  async listWorkspaces(@CurrentUser() user: AuthenticatedUser) {
    return this.workspaceService.listWorkspacesForUser(user.id);
  }

  @Post()
  async createWorkspace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { name: string; slug: string },
  ) {
    return this.workspaceService.createWorkspace(body.name, body.slug, user.id);
  }

  @Get(':workspaceId')
  async getWorkspace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.workspaceService.getWorkspace(workspaceId, user.id);
  }

  @Get(':workspaceId/members')
  async listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.workspaceService.listMembers(workspaceId, user.id);
  }

  @Post(':workspaceId/members')
  async addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { email: string; role: UserRole },
  ) {
    return this.workspaceService.addMember(workspaceId, body.email, body.role, user.id);
  }

  @Patch(':workspaceId/members/:memberId')
  async updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() body: { role: UserRole },
  ) {
    return this.workspaceService.updateMemberRole(workspaceId, memberId, body.role, user.id);
  }
}
