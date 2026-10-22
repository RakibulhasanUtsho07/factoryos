import { IsArray, IsDateString, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateCapacityCalendarDto {
  @IsString() @Matches(/^[0-9a-f-]{36}$/i)
  work_centre_id!: string;

  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  capacity_date!: string;

  @IsString() @MaxLength(80) @Matches(/^\S(?:.*\S)?$/)
  shift_code!: string;

  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10080)
  available_minutes!: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(150)
  efficiency_percent?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  skill_codes?: string[];
}
