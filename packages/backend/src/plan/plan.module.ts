import { Module } from '@nestjs/common';
import { PlanService } from './plan.service';
import { PlanController } from './plan.controller';
import { ReadinessService } from './readiness.service';
import { DryRunService } from './dry-run.service';
import { ApprovalService } from './approval.service';
import { WorkspaceModule } from '../workspace/workspace.module';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [WorkspaceModule, ProjectModule],
  controllers: [PlanController],
  providers: [PlanService, ReadinessService, DryRunService, ApprovalService],
  exports: [PlanService, ReadinessService, DryRunService, ApprovalService],
})
export class PlanModule {}
