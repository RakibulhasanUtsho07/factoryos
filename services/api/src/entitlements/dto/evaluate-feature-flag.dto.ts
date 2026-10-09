import {
  IsDateString,
  IsOptional,
} from 'class-validator';

export class EvaluateFeatureFlagDto {
  @IsOptional()
  @IsDateString()
  at?: string;
}