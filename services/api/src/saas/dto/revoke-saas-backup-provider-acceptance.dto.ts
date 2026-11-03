import { IsString, Length } from 'class-validator';

export class RevokeSaasBackupProviderAcceptanceDto {
  @IsString()
  @Length(3, 1000)
  reason!: string;
}
