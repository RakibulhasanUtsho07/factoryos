import {
  ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsObject, IsOptional,
  IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';

export class CreateGrowthExperimentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  objective!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  hypothesis!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  leading_indicators!: string[];

  @IsInt()
  @Min(1)
  @Max(3650)
  duration_days!: number;

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;

  @IsObject()
  baseline_measurements!: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  stop_conditions!: string[];
}
