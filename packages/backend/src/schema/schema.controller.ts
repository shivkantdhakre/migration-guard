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
import { SchemaService, DiscoveryOptions } from './schema.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class SchemaController {
  constructor(private readonly schemaService: SchemaService) {}

  @Post('connections/:connectionId/schema-discovery')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerDiscovery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
    @Body() body: DiscoveryOptions,
  ) {
    return this.schemaService.triggerDiscovery(connectionId, body, user.id);
  }

  @Get('schema-discovery-jobs/:jobId')
  async getDiscoveryJob(@Param('jobId') jobId: string) {
    return this.schemaService.getDiscoveryJob(jobId);
  }

  @Get('connections/:connectionId/schema-snapshots')
  async listSnapshots(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId') connectionId: string,
  ) {
    return this.schemaService.listSnapshots(connectionId, user.id);
  }

  @Get('schema-snapshots/:snapshotId')
  async getSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.schemaService.getSnapshot(snapshotId, user.id);
  }

  @Post('schema-snapshots/:snapshotId/profiles')
  async startProfiling(
    @CurrentUser() user: AuthenticatedUser,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.schemaService.startProfiling(snapshotId, user.id);
  }

  @Get('profile-runs/:profileRunId')
  async getProfileRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('profileRunId') profileRunId: string,
  ) {
    return this.schemaService.getProfileRun(profileRunId, user.id);
  }

  @Post('schema-snapshots/compare')
  @HttpCode(HttpStatus.OK)
  async compareSnapshots(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { sourceSnapshotId: string; targetSnapshotId: string },
  ) {
    return this.schemaService.compareSnapshots(
      body.sourceSnapshotId,
      body.targetSnapshotId,
      user.id,
    );
  }
}
