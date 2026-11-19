import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { MigrationService } from './migration.service';
import { ProgressService } from './progress.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class MigrationController {
  constructor(
    private readonly migrationService: MigrationService,
    private readonly progressService: ProgressService,
  ) {}

  @Post('plan-versions/:versionId/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async startRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.migrationService.startMigrationRun(versionId, user.id);
  }

  @Get('migration-runs/:runId')
  async getRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.getRun(runId, user.id);
  }

  @Get('migration-runs/:runId/progress')
  async getProgress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    await this.migrationService.getRun(runId, user.id);
    return this.progressService.getProgress(runId);
  }

  @Get('migration-runs/:runId/batches')
  async listBatches(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseInt(page || '1', 10);
    const limitNum = parseInt(limit || '20', 10);
    return this.migrationService.listBatches(runId, pageNum, limitNum, user.id);
  }

  @Get('migration-runs/:runId/batches/:batchId')
  async getBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
    @Param('batchId') batchId: string,
  ) {
    return this.migrationService.getBatch(runId, batchId, user.id);
  }

  @Post('migration-runs/:runId/pause')
  @HttpCode(HttpStatus.OK)
  async pauseRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.pauseRun(runId, user.id);
  }

  @Post('migration-runs/:runId/resume')
  @HttpCode(HttpStatus.OK)
  async resumeRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.resumeRun(runId, user.id);
  }

  @Post('migration-runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.cancelRun(runId, user.id);
  }

  @Post('migration-runs/:runId/retry-failed')
  @HttpCode(HttpStatus.OK)
  async retryFailed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.retryFailed(runId, user.id);
  }

  @Get('migration-runs/:runId/events')
  async getEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.migrationService.getEvents(runId, user.id);
  }
}
