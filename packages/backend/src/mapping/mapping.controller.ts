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
import { MappingService } from './mapping.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class MappingController {
  constructor(private readonly mappingService: MappingService) {}

  @Post('projects/:projectId/mappings')
  async createMappingProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() body: { planId: string },
  ) {
    return this.mappingService.createMappingProfile(projectId, body.planId, user.id);
  }

  @Post('mappings/:planId/versions')
  async createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Body() body: { mappingJson: any },
  ) {
    return this.mappingService.createVersion(planId, body.mappingJson, user.id);
  }

  @Get('mapping-versions/:versionId')
  async getVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.mappingService.getVersion(versionId, user.id);
  }

  @Post('mapping-versions/:versionId/validate')
  @HttpCode(HttpStatus.OK)
  async validateMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
  ) {
    return this.mappingService.validateVersion(versionId, user.id);
  }

  @Post('mapping-versions/:versionId/preview')
  @HttpCode(HttpStatus.OK)
  async previewMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() body: { sampleRecords?: any[] },
  ) {
    return this.mappingService.previewTransformation(versionId, body.sampleRecords || [], user.id);
  }
}
