import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DecideResearchRelevanceDto {
  @IsIn(['ACCEPT', 'REJECT'])
  decision!: 'ACCEPT' | 'REJECT';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
