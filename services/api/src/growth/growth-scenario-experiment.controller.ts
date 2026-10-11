import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateGrowthScenarioDto } from './dto/create-growth-scenario.dto';
import { CreateGrowthExperimentDto, RecordGrowthExperimentDecisionDto, RecordGrowthExperimentMeasurementDto } from './dto/create-growth-experiment.dto';
import { GrowthScenarioExperimentService } from './growth-scenario-experiment.service';

type GrowthRequest = Request & { factoryos?: { userId:string|null; tenantId:string|null; factoryId:string|null } };
@Controller('v2/growth/opportunities')
export class GrowthScenarioExperimentController {
 constructor(private readonly service:GrowthScenarioExperimentService){}
 @Post(':opportunityId/scenarios') @UseGuards(PermissionGuard) @RequirePermission('growth.scenarios.write') @RequireFactoryScope()
 async createScenario(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Body() body:CreateGrowthScenarioDto){const c=this.context(req);return this.service.createScenarioSnapshot(c.tenantId,c.factoryId,c.userId,opportunityId,body);}
 @Get(':opportunityId/scenarios') @UseGuards(PermissionGuard) @RequirePermission('growth.scenarios.read') @RequireFactoryScope()
 async listScenarios(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listScenarioSnapshots(c.tenantId,c.factoryId,c.userId,opportunityId,l===undefined?undefined:Number(l),o===undefined?undefined:Number(o));}
 @Post(':opportunityId/experiments') @UseGuards(PermissionGuard) @RequirePermission('growth.experiments.write') @RequireFactoryScope()
 async createExperiment(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Body() body:CreateGrowthExperimentDto){const c=this.context(req);return this.service.createExperiment(c.tenantId,c.factoryId,c.userId,opportunityId,body);}
 @Get(':opportunityId/experiments') @UseGuards(PermissionGuard) @RequirePermission('growth.experiments.read') @RequireFactoryScope()
 async listExperiments(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listExperiments(c.tenantId,c.factoryId,c.userId,opportunityId,l===undefined?undefined:Number(l),o===undefined?undefined:Number(o));}
 @Post(':opportunityId/experiments/:experimentId/decisions') @UseGuards(PermissionGuard) @RequirePermission('growth.experiments.decisions.write') @RequireFactoryScope()
 async decideExperiment(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Param('experimentId') experimentId:string,@Body() body:RecordGrowthExperimentDecisionDto){const c=this.context(req);return this.service.recordExperimentDecision(c.tenantId,c.factoryId,c.userId,opportunityId,experimentId,body);}
 @Post(':opportunityId/experiments/:experimentId/measurements') @UseGuards(PermissionGuard) @RequirePermission('growth.experiments.measurements.write') @RequireFactoryScope()
 async recordMeasurement(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Param('experimentId') experimentId:string,@Body() body:RecordGrowthExperimentMeasurementDto){const c=this.context(req);return this.service.recordExperimentMeasurement(c.tenantId,c.factoryId,c.userId,opportunityId,experimentId,body);}
 @Get(':opportunityId/experiments/:experimentId/measurements') @UseGuards(PermissionGuard) @RequirePermission('growth.experiments.read') @RequireFactoryScope()
 async listMeasurements(@Req() req:GrowthRequest,@Param('opportunityId') opportunityId:string,@Param('experimentId') experimentId:string,@Query('limit') l?:string,@Query('offset') o?:string){const c=this.context(req);return this.service.listExperimentMeasurements(c.tenantId,c.factoryId,c.userId,opportunityId,experimentId,l===undefined?undefined:Number(l),o===undefined?undefined:Number(o));}
 private context(req:GrowthRequest):{userId:string;tenantId:string;factoryId:string}{const userId=req.factoryos?.userId??null,tenantId=req.factoryos?.tenantId??null,factoryId=req.factoryos?.factoryId??null;if(!userId||!tenantId||!factoryId)throw new UnauthorizedException('Authenticated growth factory context is missing');return {userId,tenantId,factoryId};}
}
