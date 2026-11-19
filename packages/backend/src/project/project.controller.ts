import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get('workspaces/:workspaceId/projects')
  async listProjects(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.projectService.listProjects(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/projects')
  async createProject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { name: string; description?: string },
  ) {
    return this.projectService.createProject(workspaceId, body.name, body.description, user.id);
  }

  @Get('projects/:projectId')
  async getProject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.projectService.getProject(projectId, user.id);
  }

  @Patch('projects/:projectId')
  async updateProject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() body: { name?: string; description?: string; status?: string },
  ) {
    return this.projectService.updateProject(projectId, body, user.id);
  }

  @Get('projects/:projectId/activity')
  async getActivity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.projectService.getActivity(projectId, user.id);
  }
}
