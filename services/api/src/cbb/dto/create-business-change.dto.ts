import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const BUSINESS_CHANGE_TARGET_TYPES = [
  'BLUEPRINT',
  'ENTITY',
  'RELATION',
  'PROCESS',
  'PROCESS_STEP',
  'RULE',
  'TERM',
  'EXCEPTION',
] as const;

export type BusinessChangeTargetType =
  (typeof BUSINESS_CHANGE_TARGET_TYPES)[number];

export const BUSINESS_CHANGE_STATES = [
  'VERIFIED',
  'INFERRED',
  'PROPOSED',
  'CONFLICTING',
  'STALE',
] as const;

export type BusinessChangeState =
  (typeof BUSINESS_CHANGE_STATES)[number];

export class CreateBusinessChangeDto {
  @IsIn(
    BUSINESS_CHANGE_TARGET_TYPES,
  )
  target_type!:
    BusinessChangeTargetType;

  @IsOptional()
  @IsUUID()
  target_id?:
    | string
    | null;

  @IsString()
  @MaxLength(100)
  proposal_type!: string;

  @IsOptional()
  @IsIn(
    BUSINESS_CHANGE_STATES,
  )
  proposed_state?:
    | BusinessChangeState
    | null;

  @IsOptional()
  @IsObject()
  proposed_payload?:
    Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?:
    | string
    | null;
}