import { Module } from '@nestjs/common';
import { ConnectionService } from './connection.service';
import { ConnectionController } from './connection.controller';
import { CredentialsService } from './credentials.service';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({
  imports: [WorkspaceModule],
  controllers: [ConnectionController],
  providers: [ConnectionService, CredentialsService],
  exports: [ConnectionService, CredentialsService],
})
export class ConnectionModule {}
