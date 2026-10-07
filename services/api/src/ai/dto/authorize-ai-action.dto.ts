import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AuthorizeAiActionDto {
  @IsUUID()
  decision_id!: string;

  @IsString()
  @MaxLength(200)
  action_type!: string;

  @IsObject()
  target!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  resource_type?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  resource_id?: string | null;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  policy_attributes?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  approval_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string | null;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  token_ttl_seconds?: number;
}
