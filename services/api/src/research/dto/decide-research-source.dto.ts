import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DecideResearchSourceDto {
  @IsIn(['APPROVE', 'REJECT', 'REVOKE'])
  decision!: 'APPROVE' | 'REJECT' | 'REVOKE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
