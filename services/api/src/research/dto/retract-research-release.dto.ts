import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RetractResearchReleaseDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  reason!: string;
}
