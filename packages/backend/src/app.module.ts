import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { ProjectModule } from './project/project.module';
import { ConnectionModule } from './connection/connection.module';
import { SchemaModule } from './schema/schema.module';
import { MappingModule } from './mapping/mapping.module';
import { PlanModule } from './plan/plan.module';
import { MigrationModule } from './migration/migration.module';
import { ValidationModule } from './validation/validation.module';
import { ReportModule } from './report/report.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WorkspaceModule,
    ProjectModule,
    ConnectionModule,
    SchemaModule,
    MappingModule,
    PlanModule,
    MigrationModule,
    ValidationModule,
    ReportModule,
    AuditModule,
    HealthModule,
    AiModule,
  ],
})
export class AppModule {}
