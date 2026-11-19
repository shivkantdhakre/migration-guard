import { Module, Global } from '@nestjs/common';
import { AuditService } from './audit.service';
import { TimelineService } from './timeline.service';
import { AuditController } from './audit.controller';
import { WorkspaceModule } from '../workspace/workspace.module';

@Global()
@Module({
  imports: [WorkspaceModule],
  controllers: [AuditController],
  providers: [AuditService, TimelineService],
  exports: [AuditService, TimelineService],
})
export class AuditModule {}
