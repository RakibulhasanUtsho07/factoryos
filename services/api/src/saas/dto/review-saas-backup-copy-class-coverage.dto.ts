import { IsIn, IsString, Length } from 'class-validator';
export class ReviewSaasBackupCopyClassCoverageDto {
  @IsIn(['ACCEPT','REJECT']) decision!: 'ACCEPT'|'REJECT';
  @IsString() @Length(3,1000) reason!: string;
}
