import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ValidationService } from './validation.service';
import { DiscrepancyService, DiscrepancyFilter } from './discrepancy.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly discrepancyService: DiscrepancyService,
  ) {}

  @Post('migration-runs/:runId/validations')
  @HttpCode(HttpStatus.OK)
  async triggerValidation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.validationService.triggerValidation(runId, user.id);
  }

  @Get('migration-runs/:runId/validations')
  async getValidationForRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('runId') runId: string,
  ) {
    return this.validationService.getValidationForRun(runId, user.id);
  }

  @Get('validation-runs/:validationRunId')
  async getValidationRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('validationRunId') validationRunId: string,
  ) {
    return this.validationService.getValidationRun(validationRunId, user.id);
  }

  @Get('validation-runs/:validationRunId/checks')
  async getCheckResults(
    @CurrentUser() user: AuthenticatedUser,
    @Param('validationRunId') validationRunId: string,
  ) {
    return this.validationService.getCheckResults(validationRunId, user.id);
  }

  @Get('validation-runs/:validationRunId/discrepancies')
  async listDiscrepancies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('validationRunId') validationRunId: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Assert workspace access via validation run
    await this.validationService.getValidationRun(validationRunId, user.id);

    const filter: DiscrepancyFilter = {
      category,
      severity,
      status,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    };
    return this.discrepancyService.listDiscrepancies(validationRunId, filter);
  }

  @Get('discrepancies/:discrepancyId')
  async getDiscrepancy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('discrepancyId') discrepancyId: string,
  ) {
    return this.discrepancyService.getDiscrepancy(discrepancyId, user.id);
  }

  @Patch('discrepancies/:discrepancyId')
  async updateDiscrepancyStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('discrepancyId') discrepancyId: string,
    @Body() body: { status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'IGNORED'; comment?: string },
  ) {
    return this.discrepancyService.updateDiscrepancyStatus(discrepancyId, body.status, body.comment, user.id);
  }
}
