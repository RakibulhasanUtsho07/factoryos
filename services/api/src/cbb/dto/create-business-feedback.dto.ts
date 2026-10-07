import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const BUSINESS_FEEDBACK_SUBJECT_TYPES = [
  'BLUEPRINT',
  'ENTITY',
  'RELATION',
  'PROCESS',
  'PROCESS_STEP',
  'RULE',
  'TERM',
  'EXCEPTION',
  'CHANGE_PROPOSAL',
  'CONFLICT',
  'EVIDENCE',
] as const;

export type BusinessFeedbackSubjectType =
  (typeof BUSINESS_FEEDBACK_SUBJECT_TYPES)[number];

export class CreateBusinessFeedbackDto {
  @IsIn(
    BUSINESS_FEEDBACK_SUBJECT_TYPES,
  )
  subject_type!:
    BusinessFeedbackSubjectType;

  @IsUUID()
  subject_id!: string;

  @IsString()
  @MaxLength(100)
  feedback_type!: string;

  @IsOptional()
  @IsObject()
  payload_json?:
    Record<string, unknown>;
}