import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt,
  IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';

export const MAINTENANCE_CRITICALITIES = ['LOW','MEDIUM','HIGH','CRITICAL'] as const;
export const MAINTENANCE_ASSET_STATUSES = ['ACTIVE','INACTIVE','RETIRED'] as const;
export const MAINTENANCE_INTERVAL_UNITS = ['DAY','WEEK','MONTH'] as const;
export const MAINTENANCE_PM_ACTIONS = ['ACTIVATE','PAUSE','RESUME','RETIRE'] as const;
export const MAINTENANCE_WO_PRIORITIES = ['LOW','MEDIUM','HIGH','URGENT'] as const;
export const MAINTENANCE_WO_ACTIONS = ['APPROVE','START','HOLD','RESUME','COMPLETE','CANCEL'] as const;

export class CreateMaintenanceAssetDto {
  @IsString() @MaxLength(100) asset_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsString() @MaxLength(80) asset_type!: string;
  @IsOptional() @IsUUID() parent_asset_id?: string;
  @IsOptional() @IsString() @MaxLength(160) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(160) model?: string;
  @IsOptional() @IsString() @MaxLength(160) serial_number?: string;
  @IsOptional() @IsIn([...MAINTENANCE_CRITICALITIES]) criticality?: typeof MAINTENANCE_CRITICALITIES[number];
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsOptional() @IsDateString() commissioned_on?: string;
  @IsOptional() @IsDateString() warranty_expires_on?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateMaintenanceAssetDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(80) asset_type?: string;
  @IsOptional() @IsUUID() parent_asset_id?: string | null;
  @IsOptional() @IsString() @MaxLength(160) manufacturer?: string | null;
  @IsOptional() @IsString() @MaxLength(160) model?: string | null;
  @IsOptional() @IsString() @MaxLength(160) serial_number?: string | null;
  @IsOptional() @IsIn([...MAINTENANCE_CRITICALITIES]) criticality?: typeof MAINTENANCE_CRITICALITIES[number];
  @IsOptional() @IsIn([...MAINTENANCE_ASSET_STATUSES]) status?: typeof MAINTENANCE_ASSET_STATUSES[number];
  @IsOptional() @IsString() @MaxLength(255) location?: string | null;
  @IsOptional() @IsDateString() commissioned_on?: string | null;
  @IsOptional() @IsDateString() warranty_expires_on?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
  @IsString() @MaxLength(1000) reason!: string;
}

export class MaintenanceChecklistEntryDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(1000) description!: string;
  @IsOptional() @IsBoolean() required?: boolean;
}

export class CreateMaintenancePmPlanDto {
  @IsUUID() asset_id!: string;
  @IsString() @MaxLength(100) plan_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(3650) interval_value!: number;
  @IsIn([...MAINTENANCE_INTERVAL_UNITS]) interval_unit!: typeof MAINTENANCE_INTERVAL_UNITS[number];
  @IsDateString() next_due_on!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) estimated_duration_minutes?: number;
  @IsOptional() @IsBoolean() requires_shutdown?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MaintenanceChecklistEntryDto)
  checklist?: MaintenanceChecklistEntryDto[];
}

export class MaintenancePmPlanTransitionDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsIn([...MAINTENANCE_PM_ACTIONS]) action!: typeof MAINTENANCE_PM_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
}

export class GenerateDueMaintenanceWorkOrderDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class CreateMaintenanceBreakdownWorkOrderDto {
  @IsUUID() asset_id!: string;
  @IsIn([...MAINTENANCE_WO_PRIORITIES]) priority!: typeof MAINTENANCE_WO_PRIORITIES[number];
  @IsString() @MaxLength(255) title!: string;
  @IsString() @MaxLength(4000) description!: string;
  @IsOptional() @IsString() @MaxLength(100) failure_code?: string;
  @IsOptional() @IsDateString() scheduled_start_at?: string;
  @IsOptional() @IsDateString() due_at?: string;
  @IsOptional() @IsUUID() assigned_to_user_id?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MaintenanceChecklistEntryDto)
  checklist?: MaintenanceChecklistEntryDto[];
}

export class MaintenanceWorkOrderTransitionDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsIn([...MAINTENANCE_WO_ACTIONS]) action!: typeof MAINTENANCE_WO_ACTIONS[number];
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class CompleteMaintenanceTaskDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
}

export class AddMaintenanceSparePartDto {
  @IsUUID() inventory_item_id!: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) required_quantity!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class IssueMaintenanceSparePartDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) quantity!: number;
  @IsString() @MaxLength(1000) reason!: string;
}

export class ListMaintenanceAssetsQueryDto {
  @IsOptional() @IsIn([...MAINTENANCE_ASSET_STATUSES]) status?: typeof MAINTENANCE_ASSET_STATUSES[number];
  @IsOptional() @IsUUID() parent_asset_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ListMaintenancePmPlansQueryDto {
  @IsOptional() @IsIn(['DRAFT','ACTIVE','PAUSED','RETIRED']) status?: 'DRAFT'|'ACTIVE'|'PAUSED'|'RETIRED';
  @IsOptional() @IsUUID() asset_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ListMaintenanceWorkOrdersQueryDto {
  @IsOptional() @IsIn(['PM','BREAKDOWN']) work_order_type?: 'PM'|'BREAKDOWN';
  @IsOptional() @IsIn(['PLANNED','APPROVED','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED'])
  status?: 'PLANNED'|'APPROVED'|'IN_PROGRESS'|'ON_HOLD'|'COMPLETED'|'CANCELLED';
  @IsOptional() @IsIn([...MAINTENANCE_WO_PRIORITIES]) priority?: typeof MAINTENANCE_WO_PRIORITIES[number];
  @IsOptional() @IsUUID() asset_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
