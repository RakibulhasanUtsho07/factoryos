import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DecideResearchWatchlistDto {
  @IsIn(['ACTIVATE', 'PAUSE', 'RETIRE'])
  decision!: 'ACTIVATE' | 'PAUSE' | 'RETIRE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
