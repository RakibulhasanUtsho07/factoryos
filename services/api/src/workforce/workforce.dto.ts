import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const WORKFORCE_EVENT_TYPES = [
  'CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END', 'ABSENCE_RECORDED',
] as const;
export const WORKFORCE_EVENT_SOURCES = ['MANUAL', 'BIOMETRIC', 'QR', 'API'] as const;
export const WORKFORCE_ASSIGNMENT_ACTIONS = ['CONFIRM', 'CANCEL', 'COMPLETE'] as const;
export const WORKFORCE_OVERTIME_ACTIONS = ['APPROVE', 'REJECT'] as const;

export class WorkforceListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
export class WorkforceDateQueryDto {
  @IsDateString() shift_date!: string;
  @IsOptional() @IsUUID() shift_template_id?: string;
}
export class WorkforceDateRangeQueryDto {
  @IsDateString() from_date!: string;
  @IsDateString() to_date!: string;
  @IsOptional() @IsUUID() worker_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class CreateWorkforceWorkerDto {
  @IsString() @MaxLength(100) employee_code!: string;
  @IsString() @MaxLength(255) display_name!: string;
  @IsOptional() @IsUUID() linked_user_id?: string;
}
export class WorkforceWorkerStatusDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsIn(['ACTIVE', 'INACTIVE']) status!: 'ACTIVE' | 'INACTIVE';
  @IsString() @MaxLength(1000) reason!: string;
}
export class CreateWorkforceSkillDto {
  @IsString() @MaxLength(120) skill_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
}
export class AssignWorkforceSkillDto {
  @IsUUID() skill_id!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(5) skill_level!: number;
  @IsOptional() @IsDateString() certified_on?: string;
  @IsOptional() @IsDateString() certificate_expires_on?: string;
  @IsOptional() @IsString() @MaxLength(255) certificate_reference?: string;
}
export class WorkforceBiometricConsentDto {
  @IsBoolean() consent_granted!: boolean;
  @IsString() @MaxLength(255) purpose!: string;
  @IsString() @MaxLength(2000) reason!: string;
}
export class CreateWorkforceShiftDto {
  @IsString() @MaxLength(80) shift_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/) starts_at_local!: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/) ends_at_local!: string;
  @IsOptional() @IsString() @MaxLength(80) timezone_name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(360) unpaid_break_minutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(180) late_grace_minutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) overtime_threshold_minutes?: number;
}
export class UpdateWorkforceShiftDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/) starts_at_local?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/) ends_at_local?: string;
  @IsOptional() @IsString() @MaxLength(80) timezone_name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(360) unpaid_break_minutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(180) late_grace_minutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) overtime_threshold_minutes?: number;
  @IsOptional() @IsIn([...WORKFORCE_STATUSES]) status?: typeof WORKFORCE_STATUSES[number];
  @IsString() @MaxLength(2000) reason!: string;
}
export class CreateWorkforceAssignmentDto {
  @IsUUID() shift_template_id!: string;
  @IsUUID() worker_id!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) shift_date!: string;
  @IsOptional() @IsUUID() work_order_id?: string;
  @IsOptional() @IsUUID() work_order_operation_id?: string;
  @IsOptional() @IsString() @MaxLength(120) operation_code?: string;
  @IsOptional() @IsString() @MaxLength(120) required_skill_code?: string;
}
export class WorkforceAssignmentTransitionDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsIn([...WORKFORCE_ASSIGNMENT_ACTIONS]) action!: typeof WORKFORCE_ASSIGNMENT_ACTIONS[number];
  @IsString() @MaxLength(1000) reason!: string;
}
export class CreateWorkforceAttendanceEventDto {
  @IsUUID() shift_assignment_id!: string;
  @IsIn([...WORKFORCE_EVENT_TYPES]) event_type!: typeof WORKFORCE_EVENT_TYPES[number];
  @IsIn([...WORKFORCE_EVENT_SOURCES]) source_type!: typeof WORKFORCE_EVENT_SOURCES[number];
  @IsOptional() @IsString() @MaxLength(255) source_event_id?: string;
  @IsDateString() occurred_at!: string;
  @IsOptional() @IsObject() capture_metadata?: Record<string, unknown>;
}
export class CreateWorkforceAttendanceCorrectionDto {
  @IsIn([...WORKFORCE_EVENT_TYPES]) corrected_event_type!: typeof WORKFORCE_EVENT_TYPES[number];
  @IsDateString() corrected_occurred_at!: string;
  @IsString() @MaxLength(2000) reason!: string;
}
export class CreateWorkforceOvertimeDto {
  @IsUUID() shift_assignment_id!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1440) requested_minutes!: number;
  @IsString() @MaxLength(2000) reason!: string;
}
export class DecideWorkforceOvertimeDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsIn([...WORKFORCE_OVERTIME_ACTIONS]) action!: typeof WORKFORCE_OVERTIME_ACTIONS[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) approved_minutes?: number;
  @IsString() @MaxLength(2000) reason!: string;
}
export class CreateWorkforceProductivityDto {
  @IsUUID() shift_assignment_id!: string;
  @IsUUID() source_operation_event_id!: string;
  @IsUUID() work_order_id!: string;
  @IsUUID() work_order_operation_id!: string;
  @IsDateString() production_started_at!: string;
  @IsDateString() production_ended_at!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0) good_quantity!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0) scrap_quantity = 0;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) standard_minutes_per_unit!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(1440) actual_minutes!: number;
  @IsOptional() @IsString() @MaxLength(2000) scrap_reason?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}
