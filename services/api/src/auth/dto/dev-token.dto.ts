import { IsUUID } from 'class-validator';

export class DevTokenDto {
  @IsUUID()
  user_id!: string;

  @IsUUID()
  tenant_id!: string;
}