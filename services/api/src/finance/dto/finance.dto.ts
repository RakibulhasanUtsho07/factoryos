import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FINANCE_CONNECTOR_DOMAINS,
  FINANCE_CONNECTOR_MODES,
  FINANCE_FACT_TYPES,
} from '../finance-contract';

const DECIMAL = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;

export class CreateFinanceConnectorDto {
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9._-]{1,63}$/)
  connector_code!: string;

  @IsString()
  @Length(2, 160)
  @Matches(/\S/)
  display_name!: string;

  @IsString()
  @Length(2, 120)
  @Matches(/\S/)
  source_system!: string;

  @IsString()
  @IsIn(FINANCE_CONNECTOR_DOMAINS)
  domain!: (typeof FINANCE_CONNECTOR_DOMAINS)[number];

  @IsString()
  @IsIn(FINANCE_CONNECTOR_MODES)
  integration_mode!: (typeof FINANCE_CONNECTOR_MODES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  endpoint_url?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(vault|secret):\/\/[A-Za-z0-9._/-]+$/)
  secret_reference?: string;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;
}

export class TransitionFinanceConnectorDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @Length(8, 500)
  reason!: string;
}

export class FinanceFactReconciliationInputDto {
  @IsString()
  @Length(2, 80)
  expected_source_type!: string;

  @IsString()
  @Length(1, 240)
  expected_source_ref!: string;

  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  expected_quantity!: string;

  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  quantity_tolerance?: string;

  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  expected_rate!: string;

  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  rate_tolerance?: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._/-]{1,24}$/)
  uom_code!: string;
}

export class FinanceFactInputDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  external_fact_id!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  source_fact_key!: string;

  @IsString()
  @IsIn(FINANCE_FACT_TYPES)
  fact_type!: (typeof FINANCE_FACT_TYPES)[number];

  @IsString()
  @Length(2, 80)
  source_record_type!: string;

  @IsString()
  @Length(1, 240)
  @Matches(/\S/)
  source_record_ref!: string;

  @IsDateString()
  effective_at!: string;

  @IsOptional()
  @IsDateString()
  due_at?: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Matches(DECIMAL)
  amount!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  customer_ref?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  product_ref?: string;

  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  order_ref?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  cost_center_ref?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  shipment_ref?: string;

  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  source_quantity?: string;

  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL)
  source_rate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._/-]{1,24}$/)
  source_uom_code?: string;

  @IsOptional()
  @IsObject()
  metadata_snapshot?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => FinanceFactReconciliationInputDto)
  reconciliation?: FinanceFactReconciliationInputDto;
}

export class IngestFinanceFactsDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  external_batch_ref!: string;

  @IsOptional()
  @IsDateString()
  source_occurred_at?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FinanceFactInputDto)
  facts!: FinanceFactInputDto[];
}

export class ListFinanceConnectorsDto {
  @IsOptional()
  @IsString()
  @IsIn(FINANCE_CONNECTOR_DOMAINS)
  domain?: (typeof FINANCE_CONNECTOR_DOMAINS)[number];

  @IsOptional()
  @IsString()
  @IsIn(['PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REJECTED'])
  status?: 'PENDING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'REJECTED';
}

export class ListFinanceFactsDto {
  @IsOptional()
  @IsString()
  @IsIn(FINANCE_FACT_TYPES)
  fact_type?: (typeof FINANCE_FACT_TYPES)[number];

  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  customer_ref?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class FinanceMarginInputsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  customer_ref?: string;
}

export class FinanceWorkingCapitalQueryDto {
  @IsOptional()
  @IsDateString()
  as_of?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  horizon_days = 30;
}

export class ReviewFinanceReconciliationDto {
  @IsString()
  @IsIn(['RESOLVE', 'WAIVE'])
  action!: 'RESOLVE' | 'WAIVE';

  @IsString()
  @Length(8, 500)
  reason!: string;
}
