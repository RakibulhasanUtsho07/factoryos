import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class VerifyAiDecisionDto {
  @IsUUID()
  decision_id!: string;

  @IsOptional()
  @IsUUID()
  context_package_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  policy_action?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  resource_type?: string | null;

  @IsOptional()
  @IsObject()
  policy_attributes?: Record<string, unknown>;
}
