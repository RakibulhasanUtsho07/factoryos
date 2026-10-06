import {
  IsBoolean,
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateFeatureFlagDto {
  @IsString()
  @MaxLength(200)
  key!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsString()
  @MaxLength(150)
  owner!: string;

  @IsOptional()
  @IsBoolean()
  security_critical?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  change_reason?: string | null;

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  @IsOptional()
  @IsDateString()
  expires_at?: string | null;
}