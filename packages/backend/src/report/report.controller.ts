import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReportService } from './report.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Post('validation-runs/:validationRunId/reports')
  @HttpCode(HttpStatus.OK)
  async generateReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('validationRunId') validationRunId: string,
    @Body() body: { reportType?: 'EXECUTIVE' | 'DETAILED' | 'AUDIT'; format?: 'HTML' | 'CSV' },
  ) {
    return this.reportService.generateReport(
      validationRunId,
      body.reportType || 'DETAILED',
      body.format || 'HTML',
      user.id,
    );
  }

  @Get('reports/:reportId')
  async getReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reportId') reportId: string,
  ) {
    return this.reportService.getReport(reportId, user.id);
  }

  @Get('reports/:reportId/download')
  async downloadReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reportId') reportId: string,
    @Res() res: Response,
  ) {
    const file = await this.reportService.downloadReport(reportId, user.id);
    const contentType = file.format === 'CSV' ? 'text/csv' : 'text/html';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return res.send(file.content);
  }
}
