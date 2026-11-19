import { Module } from '@nestjs/common';
import { MappingService } from './mapping.service';
import { MappingController } from './mapping.controller';
import { DslValidatorService } from './dsl-validator.service';
import { MappingPreviewService } from './mapping-preview.service';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({
  imports: [WorkspaceModule],
  controllers: [MappingController],
  providers: [MappingService, DslValidatorService, MappingPreviewService],
  exports: [MappingService, DslValidatorService, MappingPreviewService],
})
export class MappingModule {}
