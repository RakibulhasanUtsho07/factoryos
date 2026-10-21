import { IsArray, IsInt, IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateCapacityCalendarDto {
  @IsInt() @Min(1)
  expected_version!: number;

  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10080)
  available_minutes!: number;

  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(150)
  efficiency_percent!: number;

  @IsArray() @IsString({ each: true })
  skill_codes!: string[];

  @IsString() @MaxLength(2000) @MinLength(1)
  change_reason!: string;
}
