import { IsNotEmpty, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
export class CreateWorkCentreDto {
  @IsString() @IsNotEmpty() @Length(1, 100) code!: string;
  @IsString() @IsNotEmpty() @Length(1, 255) name!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(99999999999999) capacity_units_per_hour?: number | null;
}
