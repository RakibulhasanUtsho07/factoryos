import {
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class LinkAuthIdentityDto {
  @IsUUID()
  user_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  issuer!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;
}