import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePolicyDto {
  @IsString()
  @MaxLength(200)
  key!: string;

  @IsString()
  @MaxLength(200)
  action!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  resource_type?: string | null;

  @IsOptional()
  @IsIn(['ALLOW', 'DENY'])
  effect?: 'ALLOW' | 'DENY';

  @IsOptional()
  @IsUUID()
  risk_class_id?: string | null;

  @IsOptional()
  @IsBoolean()
  approval_required?: boolean;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  approval_route?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'EXPIRED'])
  status?: 'ACTIVE' | 'DISABLED' | 'EXPIRED';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  priority?: number;

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  @IsOptional()
  @IsDateString()
  effective_to?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  change_reason?: string | null;
}
