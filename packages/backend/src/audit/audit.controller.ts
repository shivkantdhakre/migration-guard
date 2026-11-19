import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get('workspaces/:workspaceId/audit-events')
  async getWorkspaceAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = parseInt(limit || '50', 10);
    return this.timelineService.getWorkspaceAuditEvents(workspaceId, limitNum, user.id);
  }

  @Get('projects/:projectId/audit-events')
  async getProjectAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = parseInt(limit || '50', 10);
    return this.timelineService.getProjectAuditEvents(projectId, limitNum, user.id);
  }
}
