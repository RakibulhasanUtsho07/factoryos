import {
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class EvaluatePolicyDto {
  @IsString()
  @MaxLength(200)
  action!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  resource_type?: string | null;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  effective_at?: string;
}
