import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAiReleaseDto {
  @IsOptional()
  @IsUUID()
  decision_id?: string | null;

  @IsString()
  @MaxLength(100)
  artifact_type!: string;

  @IsString()
  @MaxLength(200)
  artifact_key!: string;

  @IsString()
  @MaxLength(100)
  version!: string;

  @IsObject()
  tests!: Record<string, unknown>;

  @IsUUID()
  approval_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  rollback_ref?: string | null;

  @IsOptional()
  @IsISO8601()
  effective_at?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
