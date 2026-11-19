import { Module } from '@nestjs/common';
import { SchemaService } from './schema.service';
import { SchemaController } from './schema.controller';
import { ConnectionModule } from '../connection/connection.module';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({
  imports: [ConnectionModule, WorkspaceModule],
  controllers: [SchemaController],
  providers: [SchemaService],
  exports: [SchemaService],
})
export class SchemaModule {}
