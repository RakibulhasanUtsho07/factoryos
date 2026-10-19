import { Type } from 'class-transformer';
import {
  IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional,
  IsString, IsUUID, Matches, Max, MaxLength, Min,
} from 'class-validator';

export const CBB_EVIDENCE_STATES = [
  'VERIFIED', 'INFERRED', 'PROPOSED', 'CONFLICTING', 'STALE',
] as const;
export type CbbEvidenceState = (typeof CBB_EVIDENCE_STATES)[number];

export const CBB_EVIDENCE_TARGET_TYPES = [
  'BLUEPRINT', 'ENTITY', 'RELATION', 'PROCESS', 'PROCESS_STEP', 'RULE', 'TERM', 'EXCEPTION',
] as const;
export type CbbEvidenceTargetType = (typeof CBB_EVIDENCE_TARGET_TYPES)[number];

export const CBB_EVIDENCE_LINK_TYPES = [
  'SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'RELATED_TO',
] as const;
export type CbbEvidenceLinkType = (typeof CBB_EVIDENCE_LINK_TYPES)[number];

export class CreateCbbEvidenceDto {
  @IsString() @MaxLength(100) source_type!: string;
  @IsString() @MaxLength(1000) source_ref!: string;
  @IsOptional() @IsString() @MaxLength(1000) source_key?: string;
  @IsOptional() @IsString() @MaxLength(150) source_system?: string;
  @IsOptional() @IsString() @MaxLength(300) source_record_id?: string;
  @IsOptional() @IsString() @MaxLength(150) source_version?: string;
  @IsOptional() @IsString() @MaxLength(2000) source_uri?: string;
  @IsDateString() source_timestamp!: string;
  @Matches(/^[a-fA-F0-9]{64}$/) content_hash!: string;
  @IsOptional() @IsString() @MaxLength(50) evidence_grade?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional() @IsIn([...CBB_EVIDENCE_STATES]) state?: CbbEvidenceState;
  @IsOptional() @IsIn(['INTERNAL', 'RESTRICTED']) visibility?: 'INTERNAL' | 'RESTRICTED';
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @IsUUID() supersedes_evidence_id?: string;
}

export class LinkCbbEvidenceDto {
  @IsIn([...CBB_EVIDENCE_TARGET_TYPES]) target_type!: CbbEvidenceTargetType;
  @IsUUID() target_id!: string;
  @IsIn([...CBB_EVIDENCE_LINK_TYPES]) link_type!: CbbEvidenceLinkType;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class ListCbbEvidenceQueryDto {
  @IsOptional() @IsString() @MaxLength(100) source_type?: string;
  @IsOptional() @IsIn([...CBB_EVIDENCE_STATES]) state?: CbbEvidenceState;
  @IsOptional() @IsString() @MaxLength(1000) source_key?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) offset?: number;
}

export class ListCbbConflictsQueryDto {
  @IsOptional() @IsIn(['OPEN', 'RESOLVED', 'DISMISSED']) status?: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  @IsOptional() @IsIn([...CBB_EVIDENCE_TARGET_TYPES]) subject_type?: CbbEvidenceTargetType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) offset?: number;
}

export class DecideCbbConflictDto {
  @IsIn(['RESOLVE', 'DISMISS']) action!: 'RESOLVE' | 'DISMISS';
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
  @IsString() @MaxLength(2000) resolution_reference!: string;
  @IsOptional() @IsUUID() resolution_evidence_id?: string;
}
