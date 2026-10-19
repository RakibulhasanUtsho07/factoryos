import { IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class RollbackResearchReleaseDto {
  @IsUUID()
  target_release_id!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  reason!: string;
}
