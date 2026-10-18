import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export const EHS_PERMIT_TYPES=['HOT_WORK','ELECTRICAL_LOTO','CONFINED_SPACE','WORK_AT_HEIGHT','CHEMICAL_HANDLING','GENERAL'] as const;
export const EHS_RISK_LEVELS=['LOW','MEDIUM','HIGH','CRITICAL'] as const;
export const EHS_PERMIT_ACTIONS=['SUBMIT','APPROVE','REJECT','VERIFY_ISOLATION','ACTIVATE','CLOSE','CANCEL','EXPIRE'] as const;
export const EHS_INCIDENT_TYPES=['INCIDENT','NEAR_MISS','UNSAFE_OBSERVATION','INJURY','ENVIRONMENTAL_RELEASE','AUDIT_FINDING'] as const;
export const EHS_SEVERITIES=['LOW','MEDIUM','HIGH','CRITICAL'] as const;
export const EHS_INCIDENT_ACTIONS=['START_INVESTIGATION','REQUIRE_ACTION','RESOLVE','CLOSE','REOPEN','CANCEL'] as const;
export const EHS_CORRECTIVE_ACTIONS=['START','SUBMIT_FOR_VERIFICATION','VERIFY','REOPEN','CANCEL'] as const;

export class IsolationPointDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(500) description!: string;
}
export class IsolationVerificationDto {
  @IsString() @MaxLength(100) code!: string;
  @IsBoolean() verified!: boolean;
  @IsString() @MaxLength(2000) evidence!: string;
}
export class CreateEhsPermitDto {
  @IsOptional() @IsUUID() work_order_id?: string;
  @IsString() @MaxLength(100) permit_number!: string;
  @IsIn([...EHS_PERMIT_TYPES]) permit_type!: typeof EHS_PERMIT_TYPES[number];
  @IsIn([...EHS_RISK_LEVELS]) risk_level!: typeof EHS_RISK_LEVELS[number];
  @IsString() @MaxLength(255) title!: string;
  @IsString() @MaxLength(4000) work_scope!: string;
  @IsString() @MaxLength(255) location!: string;
  @IsDateString() valid_from!: string;
  @IsDateString() expires_at!: string;
  @IsOptional() @IsBoolean() requires_isolation?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({each:true}) @Type(()=>IsolationPointDto)
  isolation_points?: IsolationPointDto[];
}
export class ListEhsQueryDto {
  @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(200) limit?:number;
  @IsOptional() @IsString() @MaxLength(32) status?:string;
  @IsOptional() @IsIn([...EHS_RISK_LEVELS]) risk_level?:typeof EHS_RISK_LEVELS[number];
}
export class TransitionEhsPermitDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!:number;
  @IsIn([...EHS_PERMIT_ACTIONS]) action!:typeof EHS_PERMIT_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!:string;
  @IsOptional() @IsString() @MaxLength(2000) decision_reason?:string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({each:true}) @Type(()=>IsolationVerificationDto)
  isolation_verification?:IsolationVerificationDto[];
  @IsOptional() @IsObject() closure_evidence?:Record<string,unknown>;
  @IsOptional() @IsString() @MaxLength(2000) closure_reason?:string;
}

export class CreateEhsIncidentDto {
  @IsIn([...EHS_INCIDENT_TYPES]) incident_type!:typeof EHS_INCIDENT_TYPES[number];
  @IsIn([...EHS_SEVERITIES]) severity!:typeof EHS_SEVERITIES[number];
  @IsString() @MaxLength(255) title!:string;
  @IsString() @MaxLength(4000) description!:string;
  @IsString() @MaxLength(255) location!:string;
  @IsDateString() occurred_at!:string;
  @IsOptional() @IsString() @MaxLength(2000) immediate_action?:string;
  @IsOptional() @IsUUID() assigned_owner_user_id?:string;
  @IsOptional() @IsDateString() due_at?:string;
}
export class TransitionEhsIncidentDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!:number;
  @IsIn([...EHS_INCIDENT_ACTIONS]) action!:typeof EHS_INCIDENT_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!:string;
  @IsOptional() @IsString() @MaxLength(4000) investigation_summary?:string;
  @IsOptional() @IsString() @MaxLength(4000) root_cause?:string;
  @IsOptional() @IsObject() closure_evidence?:Record<string,unknown>;
}
export class CreateEhsCorrectiveActionDto {
  @IsUUID() incident_id!:string;
  @IsString() @MaxLength(100) action_number!:string;
  @IsString() @MaxLength(4000) description!:string;
  @IsUUID() assigned_owner_user_id!:string;
  @IsDateString() due_at!:string;
}
export class TransitionEhsCorrectiveActionDto {
  @Type(()=>Number) @IsInt() @Min(1) expected_version!:number;
  @IsIn([...EHS_CORRECTIVE_ACTIONS]) action!:typeof EHS_CORRECTIVE_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!:string;
  @IsOptional() @IsString() @MaxLength(4000) root_cause?:string;
  @IsOptional() @IsObject() completion_evidence?:Record<string,unknown>;
  @IsOptional() @IsObject() verification_evidence?:Record<string,unknown>;
}
