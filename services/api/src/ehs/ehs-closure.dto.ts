import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsObject, IsOptional,
  IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';

export const EHS_DRILL_TYPES=['FIRE','EVACUATION','CHEMICAL_SPILL','MEDICAL','NATURAL_DISASTER','OTHER'] as const;
export const EHS_DRILL_ACTIONS=['START','COMPLETE','CANCEL'] as const;
export const EHS_ATTENDANCE_STATES=['PRESENT','ABSENT','EXCUSED'] as const;
export const EHS_CHEMICAL_ACTIONS=['ACTIVATE','DEACTIVATE','RETIRE'] as const;
export const EHS_CONTRACTOR_ACTIONS=['REVOKE','EXPIRE'] as const;

export class CreateEhsEmergencyDrillDto {
  @IsString() @MaxLength(100) drill_number!: string;
  @IsIn([...EHS_DRILL_TYPES]) drill_type!: typeof EHS_DRILL_TYPES[number];
  @IsString() @MaxLength(255) title!: string;
  @IsString() @MaxLength(255) location!: string;
  @IsDateString() planned_at!: string;
  @IsUUID() owner_user_id!: string;
}
export class TransitionEhsEmergencyDrillDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn([...EHS_DRILL_ACTIONS]) action!: typeof EHS_DRILL_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
  @IsOptional() @IsString() @MaxLength(4000) outcome_summary?: string;
  @IsOptional() @IsObject() close_evidence?: Record<string,unknown>;
}
export class RecordEhsDrillAttendanceDto {
  @IsString() @MaxLength(160) attendee_ref!: string;
  @IsString() @MaxLength(255) attendee_name!: string;
  @IsOptional() @IsUUID() user_id?: string;
  @IsIn([...EHS_ATTENDANCE_STATES]) attendance_status!: typeof EHS_ATTENDANCE_STATES[number];
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsObject() evidence?: Record<string,unknown>;
}
export class RecordEhsDrillResponseDto {
  @IsString() @MaxLength(100) response_code!: string;
  @IsString() @MaxLength(4000) response_action!: string;
  @IsOptional() @IsUUID() responder_user_id?: string;
  @IsOptional() @Type(()=>Number) @IsInt() @Min(0) @Max(604800) elapsed_seconds?: number;
  @IsDateString() occurred_at!: string;
  @IsObject() evidence!: Record<string,unknown>;
}
export class CreateEhsChemicalSdsDto {
  @IsString() @MaxLength(100) chemical_code!: string;
  @IsString() @MaxLength(255) chemical_name!: string;
  @IsOptional() @IsString() @MaxLength(255) manufacturer?: string;
  @IsString() @MaxLength(100) hazard_class!: string;
  @IsString() @MaxLength(255) storage_location!: string;
  @IsString() @MaxLength(100) sds_revision!: string;
  @IsString() @MaxLength(2048) sds_document_uri!: string;
  @IsDateString() sds_issued_at!: string;
  @IsDateString() sds_review_due_at!: string;
  @IsString() @MaxLength(4000) handling_instructions!: string;
  @IsString() @MaxLength(4000) emergency_instructions!: string;
}
export class TransitionEhsChemicalSdsDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn([...EHS_CHEMICAL_ACTIONS]) action!: typeof EHS_CHEMICAL_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
}
export class CreateEhsContractorInductionDto {
  @IsString() @MaxLength(100) contractor_code!: string;
  @IsString() @MaxLength(255) company_name!: string;
  @IsString() @MaxLength(255) person_name!: string;
  @IsDateString() induction_at!: string;
  @IsDateString() expires_at!: string;
  @IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(160,{each:true}) topics!: string[];
  @IsObject() evidence!: Record<string,unknown>;
}
export class TransitionEhsContractorInductionDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn([...EHS_CONTRACTOR_ACTIONS]) action!: typeof EHS_CONTRACTOR_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
}
