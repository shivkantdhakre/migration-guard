import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PlanService } from './plan.service';
import { ReadinessService } from './readiness.service';
import { DryRunService } from './dry-run.service';
import { ApprovalService } from './approval.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { CreatePlanVersionDto, ApprovalDto } from './plan.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class PlanController {
  constructor(
    private readonly planService: PlanService,
    private readonly readinessService: ReadinessService,
    private readonly dryRunService: DryRunService,
    private readonly approvalService: ApprovalService,
  ) {}

  @Post('projects/:projectId/plans')
  async createPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() body: { name: string },
  ) {
    return this.planService.createPlan(projectId, body.name, user.id);
  }

  @Get('projects/:projectId/plans')
  async listPlans(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.planService.listPlansForProject(projectId, user.id);
  }

  @Get('plans/:planId')
  async getPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
  ) {
    return this.planService.getPlan(planId, user.id);
  }

  @Post('plans/:planId/versions')
  async createPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Body() body: CreatePlanVersionDto,
  ) {
    return this.planService.createPlanVersion(planId, body, user.id);
  }

  @Get('plan-versions/:versionId')
  async getPlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.planService.getPlanVersion(versionId, user.id);
  }

  @Post('plan-versions/:versionId/readiness-check')
  @HttpCode(HttpStatus.OK)
  async checkReadiness(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    // Assert access
    await this.planService.getPlanVersion(versionId, user.id);
    return this.readinessService.checkReadiness(versionId);
  }

  @Post('plan-versions/:versionId/dry-runs')
  @HttpCode(HttpStatus.OK)
  async startDryRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    await this.planService.getPlanVersion(versionId, user.id);
    return this.dryRunService.startDryRun(versionId);
  }

  @Get('dry-runs/:dryRunId')
  async getDryRun(@Param('dryRunId') dryRunId: string) {
    return this.dryRunService.getDryRun(dryRunId);
  }

  @Post('plan-versions/:versionId/approvals')
  @HttpCode(HttpStatus.OK)
  async approvePlanVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() body: ApprovalDto,
  ) {
    return this.approvalService.submitApproval(versionId, body, user.id);
  }

  @Get('plan-versions/:versionId/approvals')
  async getApprovals(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.approvalService.getApprovalsForVersion(versionId, user.id);
  }
}
