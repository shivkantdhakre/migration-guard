import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { ValidationController } from './validation.controller';
import { DiscrepancyService } from './discrepancy.service';
import { WorkspaceModule } from '../workspace/workspace.module';
import { ConnectionModule } from '../connection/connection.module';

@Module({
  imports: [WorkspaceModule, ConnectionModule],
  controllers: [ValidationController],
  providers: [ValidationService, DiscrepancyService],
  exports: [ValidationService, DiscrepancyService],
})
export class ValidationModule {}
