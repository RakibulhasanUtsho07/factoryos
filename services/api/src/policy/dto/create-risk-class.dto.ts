import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateRiskClassDto {
  @IsString()
  @MaxLength(20)
  code!: string;

  @IsString()
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  default_approval_required?: boolean;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'EXPIRED'])
  status?: 'ACTIVE' | 'DISABLED' | 'EXPIRED';

  @IsOptional()
  @IsDateString()
  effective_from?: string;

  @IsOptional()
  @IsDateString()
  effective_to?: string | null;
}
