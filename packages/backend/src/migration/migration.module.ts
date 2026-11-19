import { Module } from '@nestjs/common';
import { MigrationService } from './migration.service';
import { MigrationController } from './migration.controller';
import { ProgressService } from './progress.service';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({
  imports: [WorkspaceModule],
  controllers: [MigrationController],
  providers: [MigrationService, ProgressService],
  exports: [MigrationService, ProgressService],
})
export class MigrationModule {}
